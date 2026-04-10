const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Order = require('../models/Order');

// ─── POST /api/orders/request ─────────────────────────────────────────────────
router.post('/request', auth, async (req, res) => {
  try {
    const { material_name, quantity, unit, site_name, reason } = req.body;
    const order = await Order.create({
      material_name, quantity, unit, site_name, reason,
      requested_by: req.user.name, requested_by_id: req.user.id,
    });
    return res.json({ success: true, message: 'Order requested' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/orders ──────────────────────────────────────────────────────────
// All orders (for owner dashboard summary)
router.get('/', auth, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 }).limit(200);
    const data = orders.map(o => ({
      id: o._id, material_name: o.material_name, quantity: o.quantity, unit: o.unit,
      site_name: o.site_name, status: o.status, requested_by: o.requested_by,
      created_at: o.createdAt, reason: o.reason,
    }));
    return res.json({ success: true, message: 'OK', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/orders/:site ────────────────────────────────────────────────────
router.get('/:site', auth, async (req, res) => {
  try {
    const orders = await Order.find({ site_name: req.params.site }).sort({ createdAt: -1 });
    const data = orders.map(o => ({
      id: o._id, material_name: o.material_name, quantity: o.quantity, unit: o.unit,
      site_name: o.site_name, status: o.status, requested_by: o.requested_by,
      created_at: o.createdAt, reason: o.reason,
    }));
    return res.json({ success: true, message: 'OK', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/orders/accept/:id ───────────────────────────────────────────────
router.put('/accept/:id', auth, async (req, res) => {
  try {
    await Order.findByIdAndUpdate(req.params.id, { status: 'accepted' });
    return res.json({ success: true, message: 'Order accepted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/orders/reject/:id ───────────────────────────────────────────────
router.put('/reject/:id', auth, async (req, res) => {
  try {
    await Order.findByIdAndUpdate(req.params.id, { status: 'rejected' });
    return res.json({ success: true, message: 'Order rejected' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
