const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Site = require('../models/Site');
const Inventory = require('../models/Inventory');
const User = require('../models/User');

// ─── GET /api/sites ───────────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const sites = await Site.find().sort({ createdAt: -1 });
    const data = await Promise.all(sites.map(async (s) => {
      const invCount = await Inventory.countDocuments({ site_name: s.name });
      const lowStock = await Inventory.countDocuments({ site_name: s.name, $expr: { $lt: ['$quantity', '$low_stock_threshold'] } });
      const managerCount = await User.countDocuments({ role: 'manager', status: 'approved', site_name: s.name });
      const assignedManager = await User.findOne({ role: 'manager', status: 'approved', site_name: s.name }, 'name phone');
      return {
        id: s._id,
        name: s.name,
        location: s.location,
        owner_id: s.owner_id,
        created_at: s.createdAt,
        manager_count: managerCount,
        total_materials: invCount,
        low_stock_count: lowStock,
        assigned_manager: assignedManager ? { name: assignedManager.name, phone: assignedManager.phone } : null,
      };
    }));
    return res.json({ success: true, message: 'OK', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/sites/create ───────────────────────────────────────────────────
router.post('/create', auth, async (req, res) => {
  try {
    const { name, location, materials } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Site name required' });

    const existing = await Site.findOne({ name });
    if (existing) return res.status(400).json({ success: false, message: 'Site with this name already exists' });

    // Site model stores material names only (quantities live in Inventory collection)
    const materialNames = (materials || []).map(m => (typeof m === 'object' && m !== null) ? m.name : m);
    const site = await Site.create({ name, location: location || '', owner_id: req.user.id, materials: materialNames });

    // Auto-create inventory items for each material
    // materials can be: ['Cement', 'Sand'] OR [{name, quantity, unit}]
    if (materials && materials.length > 0) {
      const inventoryItems = materials.map(m => {
        const isObj = typeof m === 'object' && m !== null;
        return {
          name: isObj ? m.name : m,
          quantity: isObj && m.quantity != null ? Number(m.quantity) : 0,
          unit: isObj && m.unit ? m.unit : 'units',
          site_name: name,
          category: 'Building Items',
          low_stock_threshold: 50,
        };
      });
      await Inventory.insertMany(inventoryItems);
    }

    return res.json({ success: true, message: `Site "${name}" created successfully` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
