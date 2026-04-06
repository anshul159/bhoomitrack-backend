const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Slip = require('../models/Slip');
const Inventory = require('../models/Inventory');

// ─── POST /api/slips/generate ─────────────────────────────────────────────────
router.post('/generate', auth, async (req, res) => {
  try {
    const { site_name, items } = req.body;
    const slipItems = [];

    for (const item of items) {
      const inv = await Inventory.findById(item.inventory_id);
      if (!inv) continue;
      const updatedStock = Math.max(0, inv.quantity - item.quantity_taken);
      await Inventory.findByIdAndUpdate(item.inventory_id, { quantity: updatedStock });
      slipItems.push({
        material_name: inv.name,
        quantity_taken: item.quantity_taken,
        unit: inv.unit,
        updated_stock: updatedStock,
        inventory_id: inv._id,
      });
    }

    const slip = await Slip.create({
      site_name,
      manager_id: req.user.id,
      manager_name: req.user.name,
      items: slipItems,
    });

    return res.json({
      success: true, message: 'Slip generated',
      data: {
        id: slip._id, site_name: slip.site_name,
        manager_id: slip.manager_id, manager_name: slip.manager_name,
        items: slip.items, created_at: slip.createdAt,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/slips/:site ─────────────────────────────────────────────────────
router.get('/:site', auth, async (req, res) => {
  try {
    const slips = await Slip.find({ site_name: req.params.site }).sort({ createdAt: -1 });
    const data = slips.map(s => ({
      id: s._id, site_name: s.site_name, manager_id: s.manager_id,
      manager_name: s.manager_name, items: s.items, created_at: s.createdAt,
    }));
    return res.json({ success: true, message: 'OK', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/slips/last/:site ────────────────────────────────────────────────
router.get('/last/:site', auth, async (req, res) => {
  try {
    const slip = await Slip.findOne({ site_name: req.params.site }).sort({ createdAt: -1 });
    if (!slip) return res.json({ success: false, message: 'No slips found', data: null });
    return res.json({
      success: true, message: 'OK',
      data: {
        id: slip._id, site_name: slip.site_name, manager_id: slip.manager_id,
        manager_name: slip.manager_name, items: slip.items, created_at: slip.createdAt,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
