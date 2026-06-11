const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { ownerOnly, requireApproved } = require('../middleware/roles');
const Order = require('../models/Order');
const { isNonEmptyString, isPositiveNumber, isObjectId } = require('../utils/validate');

const orderToResponse = (o) => ({
  id: o._id, material_name: o.material_name, quantity: o.quantity, unit: o.unit,
  site_name: o.site_name, status: o.status, requested_by: o.requested_by,
  created_at: o.createdAt, reason: o.reason,
});

// ─── POST /api/orders/request ─────────────────────────────────────────────────
router.post('/request', auth, requireApproved, async (req, res) => {
  try {
    const { material_name, quantity, unit, site_name, reason } = req.body;
    if (!isNonEmptyString(material_name) || !isNonEmptyString(site_name)) {
      return res.status(400).json({ success: false, message: 'Material and site are required' });
    }
    const qty = Number(quantity);
    if (!isPositiveNumber(qty)) return res.status(400).json({ success: false, message: 'Quantity must be greater than 0' });

    await Order.create({
      material_name: material_name.trim(),
      quantity: qty,
      unit: isNonEmptyString(unit, 30) ? unit : 'units',
      site_name,
      reason: typeof reason === 'string' ? reason.slice(0, 500) : '',
      requested_by: req.user.name,
      requested_by_id: req.user.id,
      orgId: req.user.orgId,
    });
    return res.json({ success: true, message: 'Order requested' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/orders ──────────────────────────────────────────────────────────
// All orders for this org (owner dashboard summary)
router.get('/', auth, async (req, res) => {
  try {
    const orders = await Order.find({ orgId: req.user.orgId }).sort({ createdAt: -1 }).limit(200).lean();
    return res.json({ success: true, message: 'OK', data: orders.map(orderToResponse) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/orders/:site ────────────────────────────────────────────────────
router.get('/:site', auth, async (req, res) => {
  try {
    const orders = await Order.find({ site_name: req.params.site, orgId: req.user.orgId }).sort({ createdAt: -1 }).limit(500).lean();
    return res.json({ success: true, message: 'OK', data: orders.map(orderToResponse) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/orders/accept/:id ───────────────────────────────────────────────
// Owner only — atomically transitions pending → accepted
router.put('/accept/:id', auth, ownerOnly, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid order id' });
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, status: 'pending', orgId: req.user.orgId },
      { status: 'accepted' },
      { new: true }
    );
    if (!order) {
      const existing = await Order.findById(req.params.id).lean();
      if (!existing) return res.status(404).json({ success: false, message: 'Order not found' });
      return res.status(400).json({ success: false, message: `Order is already ${existing.status}` });
    }
    return res.json({ success: true, message: 'Order accepted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/orders/reject/:id ───────────────────────────────────────────────
// Owner only — atomically transitions pending → rejected
router.put('/reject/:id', auth, ownerOnly, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid order id' });
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, status: 'pending', orgId: req.user.orgId },
      { status: 'rejected' },
      { new: true }
    );
    if (!order) {
      const existing = await Order.findById(req.params.id).lean();
      if (!existing) return res.status(404).json({ success: false, message: 'Order not found' });
      return res.status(400).json({ success: false, message: `Order is already ${existing.status}` });
    }
    return res.json({ success: true, message: 'Order rejected' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
