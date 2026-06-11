const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const { ownerOnly } = require('../middleware/roles');
const Site = require('../models/Site');
const Inventory = require('../models/Inventory');
const User = require('../models/User');
const { isNonEmptyString } = require('../utils/validate');

// ─── GET /api/sites ───────────────────────────────────────────────────────────
// PERFORMANCE FIX: was 4 queries per site (N+1). Now 3 queries total regardless
// of how many sites exist, using aggregation pipelines.
router.get('/', auth, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const sites = await Site.find({ orgId }).sort({ createdAt: -1 }).lean();
    if (sites.length === 0) return res.json({ success: true, message: 'OK', data: [] });

    const siteNames = sites.map(s => s.name);

    const [invAgg, mgrAgg] = await Promise.all([
      Inventory.aggregate([
        { $match: { orgId: new mongoose.Types.ObjectId(orgId), site_name: { $in: siteNames } } },
        {
          $group: {
            _id: '$site_name',
            total: { $sum: 1 },
            low: { $sum: { $cond: [{ $lt: ['$quantity', '$low_stock_threshold'] }, 1, 0] } },
          }
        }
      ]),
      User.aggregate([
        { $match: { role: 'manager', status: 'approved', site_name: { $in: siteNames }, orgId: new mongoose.Types.ObjectId(orgId) } },
        {
          $group: {
            _id: '$site_name',
            count: { $sum: 1 },
            first_manager: { $first: { name: '$name', phone: '$phone' } },
          }
        }
      ]),
    ]);

    const invMap = Object.fromEntries(invAgg.map(a => [a._id, a]));
    const mgrMap = Object.fromEntries(mgrAgg.map(a => [a._id, a]));

    const data = sites.map(s => {
      const inv = invMap[s.name];
      const mgr = mgrMap[s.name];
      return {
        id: s._id,
        name: s.name,
        location: s.location,
        owner_id: s.owner_id,
        created_at: s.createdAt,
        manager_count: mgr?.count || 0,
        total_materials: inv?.total || 0,
        low_stock_count: inv?.low || 0,
        assigned_manager: mgr?.first_manager ? { name: mgr.first_manager.name, phone: mgr.first_manager.phone || '' } : null,
      };
    });

    return res.json({ success: true, message: 'OK', data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/sites/create ───────────────────────────────────────────────────
// Owner only
router.post('/create', auth, ownerOnly, async (req, res) => {
  try {
    const { name, location, materials } = req.body;
    if (!isNonEmptyString(name)) return res.status(400).json({ success: false, message: 'Site name required' });
    if (materials && (!Array.isArray(materials) || materials.length > 200)) {
      return res.status(400).json({ success: false, message: 'Invalid materials list' });
    }

    const orgId = req.user.orgId;
    const existing = await Site.findOne({ name, orgId });
    if (existing) return res.status(400).json({ success: false, message: 'Site with this name already exists' });

    // Site model stores material names only (quantities live in Inventory collection)
    const materialNames = (materials || [])
      .map(m => (typeof m === 'object' && m !== null) ? m.name : m)
      .filter(n => isNonEmptyString(n));
    await Site.create({ name, location: location || '', owner_id: req.user.id, materials: materialNames, orgId });

    // Auto-create inventory items for each material
    // materials can be: ['Cement', 'Sand'] OR [{name, quantity, unit}]
    if (materials && materials.length > 0) {
      const inventoryItems = materials
        .filter(m => isNonEmptyString(typeof m === 'object' && m !== null ? m.name : m))
        .map(m => {
          const isObj = typeof m === 'object' && m !== null;
          const qty = isObj && m.quantity != null ? Number(m.quantity) : 0;
          return {
            name: isObj ? m.name : m,
            quantity: Number.isFinite(qty) && qty >= 0 ? qty : 0,
            unit: isObj && isNonEmptyString(m.unit, 30) ? m.unit : 'units',
            site_name: name,
            category: 'Building Items',
            low_stock_threshold: 50,
            orgId,
          };
        });
      if (inventoryItems.length > 0) await Inventory.insertMany(inventoryItems);
    }

    return res.json({ success: true, message: `Site "${name}" created successfully` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
