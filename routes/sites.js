const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const { ownerOnly } = require('../middleware/roles');
const Site = require('../models/Site');
const Inventory = require('../models/Inventory');
const Slip = require('../models/Slip');
const Order = require('../models/Order');
const User = require('../models/User');
const audit = require('../utils/audit');
const { isNonEmptyString, isNonNegativeNumber, isObjectId } = require('../utils/validate');

// ─── GET /api/sites ───────────────────────────────────────────────────────────
// 3 queries total regardless of how many sites exist, using aggregation.
router.get('/', auth, ownerOnly, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const sites = await Site.find({ orgId }).sort({ createdAt: -1 }).lean();
    if (sites.length === 0) return res.json({ success: true, message: 'OK', data: [] });

    const siteNames = sites.map(s => s.name);
    const siteIds = sites.map(s => s._id);
    const orgObjectId = new mongoose.Types.ObjectId(orgId);

    // Group on site_id where present, falling back to the denormalised name for
    // rows written before the id migration (ENH-007).
    const groupKey = { $ifNull: ['$site_id', '$site_name'] };

    const [invAgg, mgrAgg] = await Promise.all([
      Inventory.aggregate([
        {
          $match: {
            orgId: orgObjectId,
            $or: [{ site_id: { $in: siteIds } }, { site_name: { $in: siteNames } }],
          }
        },
        {
          $group: {
            _id: groupKey,
            total: { $sum: 1 },
            low: { $sum: { $cond: [{ $lt: ['$quantity', '$low_stock_threshold'] }, 1, 0] } },
            // Stock value, counting only materials that carry a price (ENH-017).
            stock_value: {
              $sum: {
                $cond: [
                  { $ifNull: ['$unit_cost', false] },
                  { $multiply: ['$quantity', '$unit_cost'] },
                  0,
                ]
              }
            },
          }
        }
      ]),
      User.aggregate([
        {
          $match: {
            role: 'manager',
            status: 'approved',
            deletedAt: null,
            orgId: orgObjectId,
            $or: [{ site_ids: { $in: siteIds } }, { site_name: { $in: siteNames } }],
          }
        },
        { $addFields: { _siteKeys: { $ifNull: ['$site_ids', []] } } },
        // A manager may hold several sites (ENH-016), so they count once per site.
        { $unwind: { path: '$_siteKeys', preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: { $ifNull: ['$_siteKeys', '$site_name'] },
            count: { $sum: 1 },
            first_manager: { $first: { name: '$name', phone: '$phone' } },
          }
        }
      ]),
    ]);

    // Aggregates key on either an id or a name; look up both.
    const index = (rows) => {
      const map = {};
      for (const r of rows) map[String(r._id)] = r;
      return map;
    };
    const invMap = index(invAgg);
    const mgrMap = index(mgrAgg);
    const pick = (map, s) => map[String(s._id)] || map[s.name];

    const data = sites.map(s => {
      const inv = pick(invMap, s);
      const mgr = pick(mgrMap, s);
      return {
        id: s._id,
        name: s.name,
        location: s.location,
        owner_id: s.owner_id,
        created_at: s.createdAt,
        manager_count: mgr?.count || 0,
        total_materials: inv?.total || 0,
        low_stock_count: inv?.low || 0,
        stock_value: inv?.stock_value ? Number(inv.stock_value.toFixed(2)) : 0,
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

    const site = await Site.create({ name, location: location || '', owner_id: req.user.id, orgId });

    // Auto-create inventory items for each material.
    // materials can be: ['Cement', 'Sand'] OR [{name, quantity, unit, low_stock_threshold, unit_cost}]
    if (materials && materials.length > 0) {
      const inventoryItems = materials
        .filter(m => isNonEmptyString(typeof m === 'object' && m !== null ? m.name : m))
        .map(m => {
          const isObj = typeof m === 'object' && m !== null;
          const qty = isObj && m.quantity != null ? Number(m.quantity) : 0;
          const threshold = isObj && m.low_stock_threshold != null ? Number(m.low_stock_threshold) : NaN;
          const cost = isObj && m.unit_cost != null ? Number(m.unit_cost) : NaN;
          return {
            name: isObj ? m.name : m,
            quantity: Number.isFinite(qty) && qty >= 0 ? qty : 0,
            unit: isObj && isNonEmptyString(m.unit, 30) ? m.unit : 'units',
            site_id: site._id,
            site_name: site.name,
            category: 'Building Items',
            low_stock_threshold: isNonNegativeNumber(threshold) ? threshold : 50,
            unit_cost: isNonNegativeNumber(cost) ? cost : null,
            orgId,
          };
        });
      if (inventoryItems.length > 0) await Inventory.insertMany(inventoryItems);
    }

    audit.record(req, {
      action: 'site.create',
      entity: 'site',
      entity_id: site._id,
      entity_label: site.name,
      site_id: site._id,
      site_name: site.name,
      after: { name: site.name, location: site.location },
    });

    return res.json({ success: true, message: `Site "${name}" created successfully`, data: { id: site._id, name: site.name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/sites/rename/:id ────────────────────────────────────────────────
// Owner only. This is the endpoint ENH-007 existed to make safe: because
// Inventory, Slip, Order and manager assignments now carry `site_id`, a rename
// only has to refresh the denormalised `site_name` copies — nothing is orphaned
// by it, which was not true before.
router.put('/rename/:id', auth, ownerOnly, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid site id' });
    const { name, location } = req.body;
    if (!isNonEmptyString(name)) return res.status(400).json({ success: false, message: 'New site name is required' });

    const orgId = req.user.orgId;
    const site = await Site.findOne({ _id: req.params.id, orgId });
    if (!site) return res.status(404).json({ success: false, message: 'Site not found' });

    const newName = name.trim();
    const oldName = site.name;

    if (newName !== oldName) {
      const clash = await Site.findOne({ name: newName, orgId, _id: { $ne: site._id } });
      if (clash) return res.status(400).json({ success: false, message: 'Another site already uses that name' });
    }

    site.name = newName;
    if (location !== undefined) site.location = String(location || '');
    await site.save();

    // Refresh the denormalised copies. Matching on id OR the old name catches
    // rows the backfill has not reached yet.
    let touched = { inventory: 0, slips: 0, orders: 0, managers: 0 };
    if (newName !== oldName) {
      const match = (extra = {}) => ({ orgId, $or: [{ site_id: site._id }, { site_name: oldName }], ...extra });
      const [inv, slips, orders] = await Promise.all([
        Inventory.updateMany(match(), { $set: { site_name: newName, site_id: site._id } }),
        Slip.updateMany(match(), { $set: { site_name: newName, site_id: site._id } }),
        Order.updateMany(match(), { $set: { site_name: newName, site_id: site._id } }),
      ]);
      const managers = await User.updateMany(
        { orgId, $or: [{ site_ids: site._id }, { site_name: oldName }] },
        { $set: { site_name: newName } }
      );
      touched = {
        inventory: inv.modifiedCount,
        slips: slips.modifiedCount,
        orders: orders.modifiedCount,
        managers: managers.modifiedCount,
      };
    }

    audit.record(req, {
      action: 'site.rename',
      entity: 'site',
      entity_id: site._id,
      entity_label: newName,
      site_id: site._id,
      site_name: newName,
      before: { name: oldName },
      after: { name: newName, ...touched },
    });

    return res.json({
      success: true,
      message: `Site renamed to "${newName}"`,
      data: { id: site._id, name: site.name, location: site.location, updated: touched },
    });
  } catch (err) {
    console.error('[SITE RENAME]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
