const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { ownerOnly } = require('../middleware/roles');
const Inventory = require('../models/Inventory');
const { isNonEmptyString, isNonNegativeNumber, isObjectId } = require('../utils/validate');

const itemToResponse = (i) => ({
  id: i._id, name: i.name, quantity: i.quantity, unit: i.unit,
  site_name: i.site_name, category: i.category, low_stock_threshold: i.low_stock_threshold,
});

// ─── GET /api/inventory/:site ─────────────────────────────────────────────────
router.get('/:site', auth, async (req, res) => {
  try {
    const items = await Inventory.find({ site_name: req.params.site }).sort({ name: 1 }).lean();
    const data = items.map(i => ({ ...itemToResponse(i), id: i._id }));
    return res.json({ success: true, message: 'OK', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/inventory/add ──────────────────────────────────────────────────
// Owner only — stock additions/corrections are an owner action
router.post('/add', auth, ownerOnly, async (req, res) => {
  try {
    const { name, quantity, unit, site_name, category, low_stock_threshold } = req.body;
    if (!isNonEmptyString(name) || !isNonEmptyString(site_name)) {
      return res.status(400).json({ success: false, message: 'Name and site are required' });
    }
    const qty = Number(quantity);
    if (!isNonNegativeNumber(qty)) return res.status(400).json({ success: false, message: 'Quantity must be a number ≥ 0' });

    const item = await Inventory.create({
      name: name.trim(),
      quantity: qty,
      unit: isNonEmptyString(unit, 30) ? unit : 'units',
      site_name,
      category: isNonEmptyString(category, 60) ? category : 'Building Items',
      low_stock_threshold: isNonNegativeNumber(Number(low_stock_threshold)) ? Number(low_stock_threshold) : 50,
    });
    return res.json({ success: true, message: 'Item added', data: itemToResponse(item) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/inventory/update/:id ───────────────────────────────────────────
// Owner only
router.put('/update/:id', auth, ownerOnly, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid item id' });
    const qty = Number(req.body.quantity);
    if (!isNonNegativeNumber(qty)) return res.status(400).json({ success: false, message: 'Quantity must be a number ≥ 0' });

    const item = await Inventory.findByIdAndUpdate(req.params.id, { quantity: qty }, { new: true });
    if (!item) return res.status(404).json({ success: false, message: 'Item not found' });
    return res.json({ success: true, message: 'Updated', data: itemToResponse(item) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── DELETE /api/inventory/delete/:id ────────────────────────────────────────
// Owner only
router.delete('/delete/:id', auth, ownerOnly, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid item id' });
    const deleted = await Inventory.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, message: 'Item not found' });
    return res.json({ success: true, message: 'Item deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
