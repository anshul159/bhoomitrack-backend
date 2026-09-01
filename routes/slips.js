const express = require('express');
const router = express.Router();
// No `auth` here on purpose — applied at the mount in server.js (PF-007).
const { ownerOnly, requireApproved } = require('../middleware/roles');
const siteAccess = require('../middleware/siteAccess');
const Slip = require('../models/Slip');
const Inventory = require('../models/Inventory');
const User = require('../models/User');
const { resolveSite, siteFilter } = require('../utils/site');
const { parsePaging, paginate } = require('../utils/pagination');
const audit = require('../utils/audit');
const { isNonEmptyString, isPositiveNumber, isObjectId } = require('../utils/validate');
const { isDuplicateKeyError } = require('../utils/duplicateKey');
const { sendToUsers } = require('../utils/push');

function formatSlip(slip) {
  return {
    id: slip._id,
    site_id: slip.site_id || null,
    site_name: slip.site_name,
    manager_id: slip.manager_id,
    manager_name: slip.manager_name,
    items: (slip.items || []).map((i) => ({
      material_name: i.material_name,
      quantity_taken: i.quantity_taken,
      unit: i.unit,
      updated_stock: i.updated_stock,
      inventory_id: i.inventory_id,
      unit_cost: i.unit_cost ?? null,
      line_total: i.line_total ?? null,
    })),
    status: slip.status,
    total_value: slip.total_value ?? null,
    created_at: slip.createdAt,
    decided_at: slip.decided_at || null,
  };
}

/**
 * Puts a slip back to pending after its inventory deduction could not be completed
 * (PF-013). The approve route claims the slip atomically before touching stock, so a
 * refusal has to release that claim or the slip would be stuck as approved with
 * nothing deducted — the exact inconsistency the claim exists to prevent.
 */
async function revertClaim(slipId, orgId) {
  await Slip.updateOne(
    { _id: slipId, orgId, status: 'approved' },
    { $set: { status: 'pending' }, $unset: { decided_by: '', decided_at: '' } }
  );
}

// ─── POST /api/slips/generate ─────────────────────────────────────────────────
// Creates slip as PENDING — does NOT touch inventory until owner approves
router.post('/generate',requireApproved, async (req, res) => {
  try {
    const { site_name, items } = req.body;
    // Optional so older builds keep working (PF-003). Accepted from the body or the
    // conventional header, whichever the client sends.
    const clientRequestId = String(
      req.body.client_request_id || req.get('Idempotency-Key') || ''
    ).trim() || null;

    if (clientRequestId && clientRequestId.length > 100) {
      return res.status(400).json({ success: false, message: 'Invalid request id' });
    }

    // Fast path: this exact intent already produced a slip. Return that slip with
    // the same shape a first attempt returns, so a retry is indistinguishable from
    // a success the client simply never heard about — which is what it is.
    if (clientRequestId) {
      const existing = await Slip.findOne({ orgId: req.user.orgId, client_request_id: clientRequestId });
      if (existing) {
        return res.json({
          success: true,
          message: 'Slip generated and awaiting owner approval',
          data: formatSlip(existing),
          idempotent_replay: true,
        });
      }
    }

    if (!isNonEmptyString(site_name)) return res.status(400).json({ success: false, message: 'Site name required' });
    if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
      return res.status(400).json({ success: false, message: 'Slip must contain between 1 and 100 items' });
    }
    for (const item of items) {
      if (!isObjectId(item.inventory_id)) return res.status(400).json({ success: false, message: 'Invalid inventory item id' });
      if (!isPositiveNumber(Number(item.quantity_taken))) {
        return res.status(400).json({ success: false, message: 'Each quantity must be a number greater than 0' });
      }
    }

    const site = await resolveSite(site_name, req.user.orgId);
    if (!site) return res.status(404).json({ success: false, message: 'Site not found' });

    // A manager may only draw against a site they actually hold. The item/site
    // check below already blocked taking another site's stock, but the slip
    // itself could still be filed against the wrong site (ENH-024, BR-011).
    if (req.user.role === 'manager') {
      const assigned = (req.user.site_ids || []).includes(String(site._id)) ||
        req.user.site_name === site.name;
      if (!assigned) {
        return res.status(403).json({ success: false, message: 'You are not assigned to this site' });
      }
    }

    // Batch-fetch inventory, scoped to this org, instead of one query per item.
    const ids = items.map(i => i.inventory_id);
    const invDocs = await Inventory.find({ _id: { $in: ids }, orgId: req.user.orgId }).lean();
    const invMap = Object.fromEntries(invDocs.map(d => [d._id.toString(), d]));

    const slipItems = [];
    for (const item of items) {
      const inv = invMap[item.inventory_id.toString()];
      if (!inv) continue;
      // INTEGRITY: an item must belong to the slip's site. Compare on id where
      // both sides have one, falling back to name for rows not yet migrated.
      const sameSite = inv.site_id
        ? String(inv.site_id) === String(site._id)
        : inv.site_name === site.name;
      if (!sameSite) continue;

      const qty = Number(item.quantity_taken);
      // Can't take more than what's actually on hand.
      if (qty > inv.quantity) {
        return res.status(400).json({
          success: false,
          message: `Only ${inv.quantity} ${inv.unit} of ${inv.name} in stock — can't take ${qty}`,
        });
      }

      // Cost is captured now, not read back at approval time, so a later price
      // change cannot rewrite what this slip was worth (ENH-017).
      const unitCost = inv.unit_cost ?? null;
      slipItems.push({
        material_name: inv.name,
        quantity_taken: qty,
        unit: inv.unit,
        updated_stock: Math.max(0, inv.quantity - qty), // informational until approved
        inventory_id: inv._id,
        unit_cost: unitCost,
        line_total: unitCost != null ? Number((unitCost * qty).toFixed(2)) : null,
      });
    }

    if (slipItems.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid materials found for this site' });
    }

    // Null when nothing on the slip is priced — a slip of unpriced materials is
    // worth "unknown", not zero.
    const priced = slipItems.filter((i) => i.line_total != null);
    const totalValue = priced.length > 0
      ? Number(priced.reduce((sum, i) => sum + i.line_total, 0).toFixed(2))
      : null;

    let slip;
    try {
      slip = await Slip.create({
        site_id: site._id,
        site_name: site.name,
        manager_id: req.user.id,
        manager_name: req.user.name,
        items: slipItems,
        status: 'pending',
        total_value: totalValue,
        orgId: req.user.orgId,
        client_request_id: clientRequestId,
      });
    } catch (err) {
      // The lookup above handles a retry that arrives after the first one finished.
      // This handles the one that arrives while it is still in flight — the actual
      // five-taps-on-a-slow-connection case (PF-003), where all five lookups miss
      // and the index is the only thing left to decide the winner.
      if (clientRequestId && isDuplicateKeyError(err)) {
        const winner = await Slip.findOne({ orgId: req.user.orgId, client_request_id: clientRequestId });
        if (winner) {
          return res.json({
            success: true,
            message: 'Slip generated and awaiting owner approval',
            data: formatSlip(winner),
            idempotent_replay: true,
          });
        }
      }
      throw err;
    }

    audit.record(req, {
      action: 'slip.generate',
      entity: 'slip',
      entity_id: slip._id,
      entity_label: `${slipItems.length} item(s)`,
      site_id: site._id,
      site_name: site.name,
      after: { status: 'pending', total_value: totalValue },
    });

    User.find({ orgId: req.user.orgId, role: { $in: ['owner', 'super_admin'] } }, 'fcmTokens fcmToken')
      .lean()
      .then((owners) => sendToUsers(
        owners,
        'New slip awaiting approval',
        `${req.user.name} submitted a slip at ${site.name}`,
        { type: 'slip_pending', slipId: String(slip._id), siteName: site.name }
      ))
      .catch(() => {});

    return res.json({ success: true, message: 'Slip generated and awaiting owner approval', data: formatSlip(slip) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/slips/pending ───────────────────────────────────────────────────
// Owner only: pending slips across all sites in this org.
// NOTE: must stay declared BEFORE GET /:site or Express matches "pending" as a site
router.get('/pending',ownerOnly, async (req, res) => {
  try {
    const paging = parsePaging(req.query, { defaultLimit: 200 });
    const filter = { status: 'pending', orgId: req.user.orgId };
    const result = await paginate(Slip, filter, paging, { createdAt: -1 }, formatSlip);
    return res.json({ success: true, message: 'OK', ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/slips/approve/:id ───────────────────────────────────────────────
// Owner only: approve a pending slip — deducts inventory NOW
router.put('/approve/:id',ownerOnly, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid slip id' });

    // Atomically claim the slip (pending → approved) so two simultaneous
    // approvals can never deduct inventory twice, and scope by orgId so an owner
    // can only approve their own organisation's slips.
    const slip = await Slip.findOneAndUpdate(
      { _id: req.params.id, status: 'pending', orgId: req.user.orgId },
      { status: 'approved', decided_by: req.user.id, decided_at: new Date() },
      { new: true }
    );
    if (!slip) {
      const existing = await Slip.findOne({ _id: req.params.id, orgId: req.user.orgId }).lean();
      if (!existing) return res.status(404).json({ success: false, message: 'Slip not found' });
      return res.status(400).json({ success: false, message: `Slip is already ${existing.status}` });
    }

    // Deduct inventory, re-checking availability as part of the write (PF-013).
    //
    // Stock is verified when the slip is WRITTEN, but it is spent here, and the two
    // can be days apart. The previous version clamped with `$max: [0, …]`, so a
    // shortfall was absorbed silently: two pending slips for 400 of a 500-bag stock
    // both passed their own check, both approved, and the slips then claimed 800 bags
    // issued where 500 existed — with the consumption reports billing the difference
    // and nothing anywhere flagging it.
    //
    // The `$gte` guard makes each deduction conditional on the stock still being
    // there, so the check and the write are one atomic step and cannot be raced apart.
    const deductible = slip.items.filter(
      item => item.inventory_id && isPositiveNumber(Number(item.quantity_taken))
    );

    // An item deleted since the slip was written is skipped, not failed — that stays
    // a graceful no-op, as PT-07 RC-07 pins it. Only a real shortfall blocks approval.
    const liveDocs = await Inventory.find(
      { _id: { $in: deductible.map(i => i.inventory_id) }, orgId: req.user.orgId },
      'name unit quantity'
    ).lean();
    const liveMap = Object.fromEntries(liveDocs.map(d => [d._id.toString(), d]));

    const short = deductible
      .map(item => ({ item, inv: liveMap[item.inventory_id.toString()] }))
      .filter(({ item, inv }) => inv && Number(inv.quantity) < Number(item.quantity_taken));

    if (short.length > 0) {
      await revertClaim(slip._id, req.user.orgId);
      const { item, inv } = short[0];
      return res.status(400).json({
        success: false,
        code: 'insufficient_stock',
        message: short.length === 1
          ? `Only ${inv.quantity} ${inv.unit} of ${inv.name} left — this slip needs ${item.quantity_taken}. Stock has changed since it was submitted.`
          : `${short.length} materials on this slip are no longer in stock in the quantities requested. Stock has changed since it was submitted.`,
      });
    }

    // Applied one at a time so a failure can be undone precisely. A bulk write
    // reports only how many ops matched, not which — and rolling back the wrong
    // line would invent stock. Slips are capped at 100 items and this is the
    // approval path, not a hot one.
    const applied = [];
    let blocked = null;

    for (const item of deductible) {
      if (!liveMap[item.inventory_id.toString()]) continue;   // deleted since — skip
      const qty = Number(item.quantity_taken);
      const updated = await Inventory.findOneAndUpdate(
        { _id: item.inventory_id, orgId: req.user.orgId, quantity: { $gte: qty } },
        { $inc: { quantity: -qty } },
        { new: true }
      );
      if (!updated) { blocked = item; break; }
      applied.push({ id: item.inventory_id, qty });
    }

    // Something changed the stock between the check above and the write — a
    // concurrent approval, or an owner editing the quantity. Put back exactly what
    // was taken and leave the slip pending, so the owner gets an error instead of a
    // half-applied deduction.
    if (blocked) {
      if (applied.length > 0) {
        await Inventory.bulkWrite(applied.map(a => ({
          updateOne: {
            filter: { _id: a.id, orgId: req.user.orgId },
            update: { $inc: { quantity: a.qty } },
          }
        })));
      }
      await revertClaim(slip._id, req.user.orgId);
      return res.status(409).json({
        success: false,
        code: 'stock_changed',
        message: 'Stock changed while this slip was being approved. Please try again.',
      });
    }

    // Refresh updated_stock on the slip items so the record reflects reality
    const invDocs = await Inventory.find(
      { _id: { $in: slip.items.map(i => i.inventory_id) }, orgId: req.user.orgId },
      'quantity'
    ).lean();
    const qtyMap = Object.fromEntries(invDocs.map(d => [d._id.toString(), d.quantity]));
    slip.items.forEach(item => {
      const q = qtyMap[item.inventory_id?.toString()];
      if (q !== undefined) item.updated_stock = q;
    });
    await slip.save();

    audit.record(req, {
      action: 'slip.approve',
      entity: 'slip',
      entity_id: slip._id,
      entity_label: `${slip.items.length} item(s)`,
      site_id: slip.site_id,
      site_name: slip.site_name,
      before: { status: 'pending' },
      after: { status: 'approved', total_value: slip.total_value },
    });

    User.findById(slip.manager_id, 'fcmTokens fcmToken')
      .lean()
      .then((manager) => manager && sendToUsers(
        [manager],
        'Slip approved',
        `Your slip at ${slip.site_name} was approved — inventory updated`,
        { type: 'slip_approved', slipId: String(slip._id), siteName: slip.site_name }
      ))
      .catch(() => {});

    return res.json({ success: true, message: 'Slip approved and inventory updated', data: formatSlip(slip) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/slips/reject/:id ────────────────────────────────────────────────
// Owner only: reject a pending slip — no inventory change
router.put('/reject/:id',ownerOnly, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid slip id' });
    const slip = await Slip.findOneAndUpdate(
      { _id: req.params.id, status: 'pending', orgId: req.user.orgId },
      { status: 'rejected', decided_by: req.user.id, decided_at: new Date() },
      { new: true }
    );
    if (!slip) {
      const existing = await Slip.findOne({ _id: req.params.id, orgId: req.user.orgId }).lean();
      if (!existing) return res.status(404).json({ success: false, message: 'Slip not found' });
      return res.status(400).json({ success: false, message: `Slip is already ${existing.status}` });
    }

    audit.record(req, {
      action: 'slip.reject',
      entity: 'slip',
      entity_id: slip._id,
      entity_label: `${slip.items.length} item(s)`,
      site_id: slip.site_id,
      site_name: slip.site_name,
      before: { status: 'pending' },
      after: { status: 'rejected' },
    });

    User.findById(slip.manager_id, 'fcmTokens fcmToken')
      .lean()
      .then((manager) => manager && sendToUsers(
        [manager],
        'Slip rejected',
        `Your slip at ${slip.site_name} was rejected`,
        { type: 'slip_rejected', slipId: String(slip._id), siteName: slip.site_name }
      ))
      .catch(() => {});

    return res.json({ success: true, message: 'Slip rejected', data: formatSlip(slip) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/slips/last/:site ────────────────────────────────────────────────
// NOTE: declared before /:site so "last" never matches as a site name
router.get('/last/:site',siteAccess, async (req, res) => {
  try {
    const filter = { orgId: req.user.orgId, ...siteFilter(req.site) };
    // A manager asking for "my last slip" means theirs, not the site's most
    // recent by anyone — otherwise the screen shows a colleague's slip.
    if (req.user.role === 'manager') filter.manager_id = req.user.id;

    const slip = await Slip.findOne(filter).sort({ createdAt: -1 }).lean();
    if (!slip) return res.json({ success: false, message: 'No slips found', data: null });
    return res.json({ success: true, message: 'OK', data: formatSlip(slip) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/slips/:site ─────────────────────────────────────────────────────
router.get('/:site',siteAccess, async (req, res) => {
  try {
    const paging = parsePaging(req.query, { defaultLimit: 500 });
    const filter = { orgId: req.user.orgId, ...siteFilter(req.site) };
    if (isNonEmptyString(req.query.status, 20)) filter.status = req.query.status;
    const result = await paginate(Slip, filter, paging, { createdAt: -1 }, formatSlip);
    return res.json({ success: true, message: 'OK', ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
