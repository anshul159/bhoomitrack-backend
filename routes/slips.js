const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { ownerOnly, requireApproved } = require('../middleware/roles');
const Slip = require('../models/Slip');
const Inventory = require('../models/Inventory');
const User = require('../models/User');
const { isNonEmptyString, isPositiveNumber, isObjectId } = require('../utils/validate');
const { sendToUsers } = require('../utils/push');

// Helper to format slip for API response
function formatSlip(slip) {
  return {
    id: slip._id,
    site_name: slip.site_name,
    manager_id: slip.manager_id,
    manager_name: slip.manager_name,
    items: slip.items,
    status: slip.status,
    created_at: slip.createdAt,
  };
}

// ─── POST /api/slips/generate ─────────────────────────────────────────────────
// Creates slip as PENDING — does NOT touch inventory until owner approves
router.post('/generate', auth, requireApproved, async (req, res) => {
  try {
    const { site_name, items } = req.body;

    // Validation: a slip must target a real site and contain at least one valid item
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

    // PERFORMANCE FIX: batch-fetch inventory instead of one query per item
    // SECURITY FIX: only fetch inventory belonging to this org
    const ids = items.map(i => i.inventory_id);
    const invDocs = await Inventory.find({ _id: { $in: ids }, orgId: req.user.orgId }).lean();
    const invMap = Object.fromEntries(invDocs.map(d => [d._id.toString(), d]));

    const slipItems = [];
    for (const item of items) {
      const inv = invMap[item.inventory_id.toString()];
      if (!inv) continue;
      // INTEGRITY FIX: an item must belong to the slip's site
      if (inv.site_name !== site_name) continue;
      const qty = Number(item.quantity_taken);
      // STOCK FIX: can't take more than what's actually on hand
      if (qty > inv.quantity) {
        return res.status(400).json({
          success: false,
          message: `Only ${inv.quantity} ${inv.unit} of ${inv.name} in stock — can't take ${qty}`,
        });
      }
      // Pre-compute what the stock would be after approval (for display only)
      const projectedStock = Math.max(0, inv.quantity - qty);
      slipItems.push({
        material_name: inv.name,
        quantity_taken: qty,
        unit: inv.unit,
        updated_stock: projectedStock,   // informational only until approved
        inventory_id: inv._id,
      });
    }

    if (slipItems.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid materials found for this site' });
    }

    const slip = await Slip.create({
      site_name,
      manager_id: req.user.id,
      manager_name: req.user.name,
      items: slipItems,
      status: 'pending',
      orgId: req.user.orgId,
    });

    // Notify the org's owner(s) — don't let a push failure affect the response
    User.find({ orgId: req.user.orgId, role: { $in: ['owner', 'super_admin'] } }, 'fcmToken')
      .lean()
      .then((owners) => sendToUsers(
        owners,
        'New slip awaiting approval',
        `${req.user.name} submitted a slip at ${site_name}`,
        { type: 'slip_pending', slipId: String(slip._id), siteName: site_name }
      ))
      .catch(() => {});

    return res.json({ success: true, message: 'Slip generated and awaiting owner approval', data: formatSlip(slip) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/slips/pending ───────────────────────────────────────────────────
// Owner only: get all pending slips across all sites (scoped to this org)
// NOTE: must stay declared BEFORE GET /:site or Express matches "pending" as a site
router.get('/pending', auth, ownerOnly, async (req, res) => {
  try {
    const slips = await Slip.find({ status: 'pending', orgId: req.user.orgId }).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, message: 'OK', data: slips.map(formatSlip) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/slips/approve/:id ───────────────────────────────────────────────
// Owner only: approve a pending slip — deducts inventory NOW
router.put('/approve/:id', auth, ownerOnly, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid slip id' });

    // CONCURRENCY FIX: atomically claim the slip (pending → approved) so two
    // simultaneous approvals can never deduct inventory twice.
    // SECURITY FIX: include orgId so owners can only approve their own org's slips
    const slip = await Slip.findOneAndUpdate(
      { _id: req.params.id, status: 'pending', orgId: req.user.orgId },
      { status: 'approved' },
      { new: true }
    );
    if (!slip) {
      const existing = await Slip.findById(req.params.id).lean();
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
    const invDocs = await Inventory.find({ _id: { $in: slip.items.map(i => i.inventory_id) }, orgId: req.user.orgId }, 'quantity').lean();
    const qtyMap = Object.fromEntries(invDocs.map(d => [d._id.toString(), d.quantity]));
    slip.items.forEach(item => {
      const q = qtyMap[item.inventory_id?.toString()];
      if (q !== undefined) item.updated_stock = q;
    });
    await slip.save();

    User.findById(slip.manager_id, 'fcmToken')
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
      { status: 'rejected' },
      { new: true }
    );
    if (!slip) {
      const existing = await Slip.findById(req.params.id).lean();
      if (!existing) return res.status(404).json({ success: false, message: 'Slip not found' });
      return res.status(400).json({ success: false, message: `Slip is already ${existing.status}` });
    }

    User.findById(slip.manager_id, 'fcmToken')
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
router.get('/last/:site', auth, async (req, res) => {
  try {
    const slip = await Slip.findOne({ site_name: req.params.site, orgId: req.user.orgId }).sort({ createdAt: -1 }).lean();
    if (!slip) return res.json({ success: false, message: 'No slips found', data: null });
    return res.json({ success: true, message: 'OK', data: formatSlip(slip) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/slips/:site ─────────────────────────────────────────────────────
router.get('/:site', auth, async (req, res) => {
  try {
    const slips = await Slip.find({ site_name: req.params.site, orgId: req.user.orgId }).sort({ createdAt: -1 }).limit(500).lean();
    return res.json({ success: true, message: 'OK', data: slips.map(formatSlip) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
