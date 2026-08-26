const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { ownerOnly, requireApproved } = require('../middleware/roles');
const siteAccess = require('../middleware/siteAccess');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const User = require('../models/User');
const { resolveSite, siteFilter } = require('../utils/site');
const { parsePaging, paginate } = require('../utils/pagination');
const { sendToUsers } = require('../utils/push');
const audit = require('../utils/audit');
const { isNonEmptyString, isPositiveNumber, isObjectId } = require('../utils/validate');

const orderToResponse = (o) => ({
  id: o._id,
  material_name: o.material_name,
  quantity: o.quantity,
  unit: o.unit,
  site_id: o.site_id || null,
  site_name: o.site_name,
  status: o.status,
  requested_by: o.requested_by,
  created_at: o.createdAt,
  reason: o.reason,
  unit_cost: o.unit_cost ?? null,
  estimated_total: o.estimated_total ?? null,
  decided_at: o.decided_at || null,
  decision_note: o.decision_note || '',
});

// ─── POST /api/orders/request ─────────────────────────────────────────────────
// Manager: ask the owner for material (CR-003).
//
// The request half of this feature was deleted as dead code in commit 6ee853c,
// which left the owner-facing half — the Orders screen and the whole Procurement
// report — running on data nothing could add to. This is that half rebuilt.
//
// The site is taken from the manager's own assignment, never from the body, so a
// manager cannot raise a request against a site they do not hold.
router.post('/request', auth, requireApproved, async (req, res) => {
  try {
    const { material_name, quantity, unit, reason, site_name } = req.body;

    if (!isNonEmptyString(material_name, 200)) {
      return res.status(400).json({ success: false, message: 'Material name is required' });
    }
    const qty = Number(quantity);
    if (!isPositiveNumber(qty)) {
      return res.status(400).json({ success: false, message: 'Quantity must be a number greater than 0' });
    }

    // Owners may raise a request for any of their sites; a manager is pinned to
    // theirs regardless of what the body says.
    const isOwner = req.user.role === 'owner' || req.user.role === 'super_admin';
    const requestedSite = isOwner ? site_name : (req.user.site_name || site_name);

    const site = await resolveSite(requestedSite, req.user.orgId);
    if (!site) {
      return res.status(400).json({ success: false, message: 'You are not assigned to a site yet' });
    }
    if (!isOwner) {
      const assigned = (req.user.site_ids || []).includes(String(site._id)) ||
        req.user.site_name === site.name;
      if (!assigned) {
        return res.status(403).json({ success: false, message: 'You are not assigned to this site' });
      }
    }

    // Price the request from the site's own stock record where the material is
    // already known, so the owner sees what saying yes will cost (ENH-017).
    const existing = await Inventory.findOne({
      orgId: req.user.orgId,
      name: new RegExp(`^${material_name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      ...siteFilter(site),
    }).lean();

    const unitCost = existing?.unit_cost ?? null;
    const resolvedUnit = isNonEmptyString(unit, 30) ? unit : (existing?.unit || 'units');

    const order = await Order.create({
      material_name: material_name.trim(),
      quantity: qty,
      unit: resolvedUnit,
      site_id: site._id,
      site_name: site.name,
      status: 'pending',
      requested_by: req.user.name || '',
      requested_by_id: req.user.id,
      reason: isNonEmptyString(reason, 500) ? reason.trim() : '',
      unit_cost: unitCost,
      estimated_total: unitCost != null ? Number((unitCost * qty).toFixed(2)) : null,
      orgId: req.user.orgId,
    });

    audit.record(req, {
      action: 'order.request',
      entity: 'order',
      entity_id: order._id,
      entity_label: order.material_name,
      site_id: site._id,
      site_name: site.name,
      after: { quantity: order.quantity, unit: order.unit, status: 'pending' },
    });

    // Notify the org's owner(s) — a push failure must not affect the response.
    User.find({ orgId: req.user.orgId, role: { $in: ['owner', 'super_admin'] } }, 'fcmTokens fcmToken')
      .lean()
      .then((owners) => sendToUsers(
        owners,
        'New material request',
        `${req.user.name} requested ${qty} ${resolvedUnit} of ${order.material_name} at ${site.name}`,
        { type: 'order_pending', orderId: String(order._id), siteName: site.name }
      ))
      .catch(() => {});

    return res.json({ success: true, message: 'Request sent to the owner', data: orderToResponse(order) });
  } catch (err) {
    console.error('[ORDER REQUEST]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/orders ──────────────────────────────────────────────────────────
// All orders for this org (owner dashboard summary)
router.get('/', auth, ownerOnly, async (req, res) => {
  try {
    const paging = parsePaging(req.query, { defaultLimit: 200 });
    const filter = { orgId: req.user.orgId };
    if (isNonEmptyString(req.query.status, 20)) filter.status = req.query.status;
    const result = await paginate(Order, filter, paging, { createdAt: -1 }, orderToResponse);
    return res.json({ success: true, message: 'OK', ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/orders/:site ────────────────────────────────────────────────────
router.get('/:site', auth, siteAccess, async (req, res) => {
  try {
    const paging = parsePaging(req.query, { defaultLimit: 500 });
    const filter = { orgId: req.user.orgId, ...siteFilter(req.site) };
    const result = await paginate(Order, filter, paging, { createdAt: -1 }, orderToResponse);
    return res.json({ success: true, message: 'OK', ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Shared by accept and reject — both atomically claim a pending order so two
// simultaneous decisions cannot both land.
async function decide(req, res, nextStatus, pastTense) {
  if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid order id' });

  const order = await Order.findOneAndUpdate(
    { _id: req.params.id, status: 'pending', orgId: req.user.orgId },
    {
      status: nextStatus,
      decided_by: req.user.id,
      decided_at: new Date(),
      decision_note: isNonEmptyString(req.body?.note, 500) ? req.body.note.trim() : '',
    },
    { new: true }
  );

  if (!order) {
    const existing = await Order.findOne({ _id: req.params.id, orgId: req.user.orgId }).lean();
    if (!existing) return res.status(404).json({ success: false, message: 'Order not found' });
    return res.status(400).json({ success: false, message: `Order is already ${existing.status}` });
  }

  audit.record(req, {
    action: `order.${nextStatus}`,
    entity: 'order',
    entity_id: order._id,
    entity_label: order.material_name,
    site_id: order.site_id,
    site_name: order.site_name,
    before: { status: 'pending' },
    after: { status: nextStatus },
    note: order.decision_note,
  });

  if (order.requested_by_id) {
    User.findById(order.requested_by_id, 'fcmTokens fcmToken')
      .lean()
      .then((manager) => manager && sendToUsers(
        [manager],
        `Request ${pastTense}`,
        `Your request for ${order.quantity} ${order.unit} of ${order.material_name} was ${pastTense}`,
        { type: `order_${nextStatus}`, orderId: String(order._id), siteName: order.site_name }
      ))
      .catch(() => {});
  }

  return res.json({ success: true, message: `Order ${pastTense}`, data: orderToResponse(order) });
}

// ─── PUT /api/orders/accept/:id ───────────────────────────────────────────────
router.put('/accept/:id', auth, ownerOnly, async (req, res) => {
  try {
    return await decide(req, res, 'accepted', 'accepted');
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/orders/reject/:id ───────────────────────────────────────────────
router.put('/reject/:id', auth, ownerOnly, async (req, res) => {
  try {
    return await decide(req, res, 'rejected', 'rejected');
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
