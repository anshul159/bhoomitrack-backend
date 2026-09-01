const express = require('express');
const router = express.Router();
// No `auth` here on purpose — applied at the mount in server.js (PF-007).
const { ownerOnly } = require('../middleware/roles');
const siteAccess = require('../middleware/siteAccess');
const Inventory = require('../models/Inventory');
const { resolveSite, siteFilter } = require('../utils/site');
const { parsePaging, paginate } = require('../utils/pagination');
const audit = require('../utils/audit');
const { isNonEmptyString, isNonNegativeNumber, isObjectId } = require('../utils/validate');

const itemToResponse = (i) => ({
  id: i._id,
  name: i.name,
  quantity: i.quantity,
  unit: i.unit,
  site_id: i.site_id || null,
  site_name: i.site_name,
  category: i.category,
  low_stock_threshold: i.low_stock_threshold,
  unit_cost: i.unit_cost ?? null,
  // Convenience for the app's low-stock badge, so the rule lives in one place.
  is_low: typeof i.quantity === 'number' && i.quantity < i.low_stock_threshold,
});

// Reads an optional numeric body field. Returns `undefined` when absent (leave
// unchanged), `null` when explicitly cleared, or the number.
function optionalNumber(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

// ─── GET /api/inventory/:site ─────────────────────────────────────────────────
// siteAccess enforces that a manager can only read their own site (ENH-024).
router.get('/:site',siteAccess, async (req, res) => {
  try {
    const paging = parsePaging(req.query, { defaultLimit: 500 });
    const filter = { orgId: req.user.orgId, ...siteFilter(req.site) };
    const result = await paginate(Inventory, filter, paging, { name: 1 }, itemToResponse);
    return res.json({ success: true, message: 'OK', ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/inventory/add ──────────────────────────────────────────────────
// Owner only — stock additions/corrections are an owner action
router.post('/add',ownerOnly, async (req, res) => {
  try {
    const { name, quantity, unit, site_name, category, low_stock_threshold, unit_cost } = req.body;
    if (!isNonEmptyString(name) || !isNonEmptyString(site_name)) {
      return res.status(400).json({ success: false, message: 'Name and site are required' });
    }
    const qty = Number(quantity);
    if (!isNonNegativeNumber(qty)) return res.status(400).json({ success: false, message: 'Quantity must be a number ≥ 0' });

    const site = await resolveSite(site_name, req.user.orgId);
    if (!site) return res.status(404).json({ success: false, message: 'Site not found' });

    // ENH-022 — the owner sets the threshold per material; 50 stays the default.
    const threshold = optionalNumber(low_stock_threshold);
    if (Number.isNaN(threshold) || (threshold !== undefined && threshold !== null && threshold < 0)) {
      return res.status(400).json({ success: false, message: 'Low stock threshold must be a number ≥ 0' });
    }

    const cost = optionalNumber(unit_cost);
    if (Number.isNaN(cost) || (cost !== undefined && cost !== null && cost < 0)) {
      return res.status(400).json({ success: false, message: 'Unit cost must be a number ≥ 0' });
    }

    const item = await Inventory.create({
      name: name.trim(),
      quantity: qty,
      unit: isNonEmptyString(unit, 30) ? unit : 'units',
      site_id: site._id,
      site_name: site.name,
      category: isNonEmptyString(category, 60) ? category : 'Building Items',
      low_stock_threshold: threshold === undefined || threshold === null ? 50 : threshold,
      unit_cost: cost === undefined ? null : cost,
      orgId: req.user.orgId,
    });

    audit.record(req, {
      action: 'inventory.create',
      entity: 'inventory',
      entity_id: item._id,
      entity_label: item.name,
      site_id: site._id,
      site_name: site.name,
      after: {
        quantity: item.quantity,
        unit: item.unit,
        low_stock_threshold: item.low_stock_threshold,
        unit_cost: item.unit_cost,
      },
    });

    return res.json({ success: true, message: 'Item added', data: itemToResponse(item) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/inventory/update/:id ───────────────────────────────────────────
// Owner only. Accepts any of quantity / low_stock_threshold / unit_cost; each is
// optional so a caller can change one without resending the others (ENH-022).
router.put('/update/:id',ownerOnly, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid item id' });

    const update = {};

    if (req.body.quantity !== undefined) {
      const qty = Number(req.body.quantity);
      if (!isNonNegativeNumber(qty)) return res.status(400).json({ success: false, message: 'Quantity must be a number ≥ 0' });
      update.quantity = qty;
    }

    if (req.body.low_stock_threshold !== undefined) {
      const threshold = optionalNumber(req.body.low_stock_threshold);
      if (threshold === null || Number.isNaN(threshold) || threshold < 0) {
        return res.status(400).json({ success: false, message: 'Low stock threshold must be a number ≥ 0' });
      }
      update.low_stock_threshold = threshold;
    }

    if (req.body.unit_cost !== undefined) {
      const cost = optionalNumber(req.body.unit_cost);
      if (Number.isNaN(cost) || (cost !== null && cost < 0)) {
        return res.status(400).json({ success: false, message: 'Unit cost must be a number ≥ 0' });
      }
      update.unit_cost = cost;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    const before = await Inventory.findOne({ _id: req.params.id, orgId: req.user.orgId }).lean();
    if (!before) return res.status(404).json({ success: false, message: 'Item not found' });

    const item = await Inventory.findOneAndUpdate(
      { _id: req.params.id, orgId: req.user.orgId },
      update,
      { new: true }
    );
    if (!item) return res.status(404).json({ success: false, message: 'Item not found' });

    // An owner can change stock directly, so this is exactly the change a dispute
    // turns on. `reason` is the field the app already sent and the API used to
    // throw away (ENH-008/ENH-022).
    const changed = audit.diff(before, item, ['quantity', 'low_stock_threshold', 'unit_cost']);
    if (changed) {
      audit.record(req, {
        action: 'inventory.update',
        entity: 'inventory',
        entity_id: item._id,
        entity_label: item.name,
        site_id: item.site_id,
        site_name: item.site_name,
        before: changed.before,
        after: changed.after,
        note: isNonEmptyString(req.body.reason, 500) ? req.body.reason.trim() : '',
      });
    }

    return res.json({ success: true, message: 'Updated', data: itemToResponse(item) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── DELETE /api/inventory/delete/:id ────────────────────────────────────────
// Owner only
router.delete('/delete/:id',ownerOnly, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid item id' });
    const deleted = await Inventory.findOneAndDelete({ _id: req.params.id, orgId: req.user.orgId });
    if (!deleted) return res.status(404).json({ success: false, message: 'Item not found' });

    audit.record(req, {
      action: 'inventory.delete',
      entity: 'inventory',
      entity_id: deleted._id,
      entity_label: deleted.name,
      site_id: deleted.site_id,
      site_name: deleted.site_name,
      before: { quantity: deleted.quantity, unit: deleted.unit, unit_cost: deleted.unit_cost },
    });

    return res.json({ success: true, message: 'Item deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
