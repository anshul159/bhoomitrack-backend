const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Inventory = require('../models/Inventory');

// ─── GET /api/inventory/:site ─────────────────────────────────────────────────
router.get('/:site', auth, async (req, res) => {
  try {
    const items = await Inventory.find({ site_name: req.params.site }).sort({ name: 1 });
    const data = items.map(i => ({
      id: i._id, name: i.name, quantity: i.quantity, unit: i.unit,
      site_name: i.site_name, category: i.category, low_stock_threshold: i.low_stock_threshold,
    }));
    return res.json({ success: true, message: 'OK', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/inventory/add ──────────────────────────────────────────────────
router.post('/add', auth, async (req, res) => {
  try {
    const { name, quantity, unit, site_name, category, low_stock_threshold } = req.body;
    const item = await Inventory.create({ name, quantity, unit, site_name, category, low_stock_threshold });
    return res.json({
      success: true, message: 'Item added',
      data: { id: item._id, name: item.name, quantity: item.quantity, unit: item.unit, site_name: item.site_name, category: item.category, low_stock_threshold: item.low_stock_threshold }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/inventory/update/:id ───────────────────────────────────────────
router.put('/update/:id', auth, async (req, res) => {
  try {
    const { quantity } = req.body;
    const item = await Inventory.findByIdAndUpdate(req.params.id, { quantity }, { new: true });
    if (!item) return res.status(404).json({ success: false, message: 'Item not found' });
    return res.json({
      success: true, message: 'Updated',
      data: { id: item._id, name: item.name, quantity: item.quantity, unit: item.unit, site_name: item.site_name, category: item.category, low_stock_threshold: item.low_stock_threshold }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── DELETE /api/inventory/delete/:id ────────────────────────────────────────
router.delete('/delete/:id', auth, async (req, res) => {
  try {
    await Inventory.findByIdAndDelete(req.params.id);
    return res.json({ success: true, message: 'Item deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
