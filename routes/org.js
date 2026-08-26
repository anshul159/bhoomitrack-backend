const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { ownerOnly } = require('../middleware/roles');
const Organization = require('../models/Organization');
const Site = require('../models/Site');
const Inventory = require('../models/Inventory');
const Slip = require('../models/Slip');
const Order = require('../models/Order');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const audit = require('../utils/audit');
const { isNonEmptyString } = require('../utils/validate');

// Organisation, subscription and data-portability endpoints.
//
// Mounted OUTSIDE the subscription gate on purpose (see server.js): a customer
// whose trial has lapsed must still be able to see what they owe and to take
// their data with them. Locking those two things behind payment is the one thing
// that turns a billing problem into a hostage situation.

// ─── GET /api/org ─────────────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const org = await Organization.findById(req.user.orgId).lean();
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });
    return res.json({
      success: true,
      data: { id: org._id, name: org.name, currency: org.currency || 'INR' },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/org/subscription ────────────────────────────────────────────────
// What the app shows on a billing screen, and what it shows when the API has
// started answering 402.
router.get('/subscription', auth, async (req, res) => {
  try {
    const org = await Organization.findById(req.user.orgId);
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });

    const now = new Date();
    const active = org.isActive(now);
    const endsAt = org.status === 'trialing' ? org.trialEndsAt : org.currentPeriodEnd;
    const daysRemaining = endsAt
      ? Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)))
      : null;

    return res.json({
      success: true,
      data: {
        plan: org.plan,
        status: org.status,
        active,
        reason: active ? null : org.inactiveReason(now),
        trial_ends_at: org.trialEndsAt,
        current_period_end: org.currentPeriodEnd,
        days_remaining: daysRemaining,
        currency: org.currency || 'INR',
        // No payment provider is integrated yet, so there is nowhere to send a
        // customer to pay. The app should treat this as "contact us".
        billing_portal_url: null,
        provider: org.billingProvider,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/org/settings ────────────────────────────────────────────────────
router.put('/settings', auth, ownerOnly, async (req, res) => {
  try {
    const org = await Organization.findById(req.user.orgId);
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });

    const before = { name: org.name, currency: org.currency };
    if (isNonEmptyString(req.body?.name, 200)) org.name = req.body.name.trim();
    if (isNonEmptyString(req.body?.currency, 8)) org.currency = req.body.currency.trim().toUpperCase();
    await org.save();

    audit.record(req, {
      action: 'org.update',
      entity: 'organization',
      entity_id: org._id,
      entity_label: org.name,
      before,
      after: { name: org.name, currency: org.currency },
    });

    return res.json({ success: true, message: 'Saved', data: { name: org.name, currency: org.currency } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/org/export ──────────────────────────────────────────────────────
// Full organisation data export (ENH-013).
//
// A customer who knows they can leave with their data is more willing to start,
// and the DPDP Act gives a portability right. JSON rather than CSV because the
// shape is relational — sites own inventory, slips reference both — and a bundle
// of CSVs loses that.
router.get('/export', auth, ownerOnly, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const org = await Organization.findById(orgId).lean();
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });

    const [sites, inventory, slips, orders, users, auditLog] = await Promise.all([
      Site.find({ orgId }).lean(),
      Inventory.find({ orgId }).lean(),
      Slip.find({ orgId }).lean(),
      Order.find({ orgId }).lean(),
      // Credentials and push tokens are deliberately not exported.
      User.find({ orgId }, '-password -otpHash -otpExpiry -otpAttempts -fcmTokens -fcmToken -tokenVersion').lean(),
      AuditLog.find({ orgId }).sort({ createdAt: -1 }).limit(50000).lean(),
    ]);

    const payload = {
      exported_at: new Date().toISOString(),
      format_version: 1,
      organization: {
        id: org._id, name: org.name, currency: org.currency,
        plan: org.plan, status: org.status, created_at: org.createdAt,
      },
      counts: {
        sites: sites.length, inventory: inventory.length, slips: slips.length,
        orders: orders.length, users: users.length, audit_log: auditLog.length,
      },
      sites, inventory, slips, orders, users, audit_log: auditLog,
    };

    audit.record(req, {
      action: 'org.export',
      entity: 'organization',
      entity_id: org._id,
      entity_label: org.name,
      after: payload.counts,
    });

    const stamp = new Date().toISOString().slice(0, 10);
    const safeName = String(org.name).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bhoomitrack-${safeName}-${stamp}.json"`);
    return res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('[ORG EXPORT]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── DELETE /api/org ──────────────────────────────────────────────────────────
// Deletes the whole organisation and everything in it. Requires the owner to type
// the company name back, because there is no undo and this is the one action that
// destroys a customer's entire history.
router.delete('/', auth, ownerOnly, async (req, res) => {
  try {
    const org = await Organization.findById(req.user.orgId);
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });

    if (req.body?.confirmName !== org.name) {
      return res.status(400).json({
        success: false,
        message: 'Type the company name exactly to confirm deletion',
      });
    }

    const orgId = org._id;
    const counts = {};
    for (const [key, Model] of Object.entries({
      inventory: Inventory, slips: Slip, orders: Order, sites: Site, users: User, audit: AuditLog,
    })) {
      const r = await Model.deleteMany({ orgId });
      counts[key] = r.deletedCount;
    }
    await Organization.deleteOne({ _id: orgId });

    console.log(`[ORG DELETE] ${org.name} (${orgId}) deleted by ${req.user.id}:`, counts);
    return res.json({ success: true, message: 'Company and all its data have been deleted', data: counts });
  } catch (err) {
    console.error('[ORG DELETE]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
