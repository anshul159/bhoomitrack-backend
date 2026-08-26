const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { ownerOnly, requireApproved } = require('../middleware/roles');
const siteAccess = require('../middleware/siteAccess');
const Slip = require('../models/Slip');
const Inventory = require('../models/Inventory');
const User = require('../models/User');
const { resolveSite, siteFilter } = require('../utils/site');
const { parsePaging, paginate } = require('../utils/pagination');
const audit = require('../utils/audit');
const { isNonEmptyString, isPositiveNumber, isObjectId } = require('../utils/validate');
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

// ─── POST /api/slips/generate ─────────────────────────────────────────────────
// Creates slip as PENDING — does NOT touch inventory until owner approves
router.post('/generate', auth, requireApproved, async (req, res) => {
  try {
    const { site_name, items } = req.body;

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

    const slip = await Slip.create({
      site_id: site._id,
      site_name: site.name,
      manager_id: req.user.id,
      manager_name: req.user.name,
      items: slipItems,
      status: 'pending',
      total_value: totalValue,
      orgId: req.user.orgId,
    });

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
router.get('/pending', auth, ownerOnly, async (req, res) => {
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
router.put('/approve/:id', auth, ownerOnly, async (req, res) => {
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

    // Deduct inventory atomically per item, clamped at 0 (single bulk operation)
    const ops = slip.items
      .filter(item => item.inventory_id && isPositiveNumber(Number(item.quantity_taken)))
      .map(item => ({
        updateOne: {
          filter: { _id: item.inventory_id, orgId: req.user.orgId },
          update: [{
            $set: {
              quantity: {
                $max: [0, { $subtract: [{ $ifNull: ['$quantity', 0] }, Number(item.quantity_taken)] }]
              }
            }
          }],
        }
      }));
    if (ops.length > 0) await Inventory.bulkWrite(ops);

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
router.put('/reject/:id', auth, ownerOnly, async (req, res) => {
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
router.get('/last/:site', auth, siteAccess, async (req, res) => {
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
router.get('/:site', auth, siteAccess, async (req, res) => {
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
