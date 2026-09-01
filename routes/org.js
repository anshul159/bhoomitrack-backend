const express = require('express');
const router = express.Router();
// No `auth` here on purpose — applied at the mount in server.js (PF-007). Note that
// org is mounted with `auth, requireOrgId` but WITHOUT requireActiveOrg, so a lapsed
// customer can still see what they owe and export their data.
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
router.get('/',async (req, res) => {
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
router.get('/subscription',async (req, res) => {
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
router.put('/settings',ownerOnly, async (req, res) => {
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
// Streamed, not materialised (PF-009).
//
// This used to `find()` every collection with no limit and hold the whole result in
// memory before serialising it. Measured at ~2 KB per slip that is 1 MB for a small
// firm and ~487 MB for a large one — and peak memory exceeds the transferred size,
// because the documents, the array and the JSON string all exist at once. On a
// 512 MB instance one large export is an OOM, and with a single instance that takes
// every other customer down with it.
//
// A cap was the obvious fix and the wrong one: this endpoint exists for the DPDP
// Act's portability right, so a truncated export defeats its whole purpose. Streaming
// from a cursor keeps the response complete while holding one document at a time.
//
// AuditLog keeps its 50,000 cap because it is operational data about the account
// rather than the customer's own records — it is the one collection where a bound is
// honest.
const AUDIT_EXPORT_LIMIT = 50000;

router.get('/export',ownerOnly, async (req, res) => {
  const orgId = req.user.orgId;
  let org;
  try {
    org = await Organization.findById(orgId).lean();
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });
  } catch (err) {
    console.error('[ORG EXPORT]', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }

  // Counts come from countDocuments rather than from the arrays, because with a
  // stream there is no array to measure until it is already sent. They are indexed
  // counts and cheap.
  let counts;
  try {
    const [sites, inventory, slips, orders, users, auditLog] = await Promise.all([
      Site.countDocuments({ orgId }),
      Inventory.countDocuments({ orgId }),
      Slip.countDocuments({ orgId }),
      Order.countDocuments({ orgId }),
      User.countDocuments({ orgId }),
      AuditLog.countDocuments({ orgId }),
    ]);
    counts = {
      sites, inventory, slips, orders, users,
      audit_log: Math.min(auditLog, AUDIT_EXPORT_LIMIT),
      audit_log_total: auditLog,
    };
  } catch (err) {
    console.error('[ORG EXPORT]', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const safeName = String(org.name).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bhoomitrack-${safeName}-${stamp}.json"`);

  // Respect backpressure: if the socket's buffer is full, wait for it to drain
  // rather than queueing the whole export in memory, which would reintroduce the
  // problem this rewrite exists to solve.
  const write = (chunk) =>
    res.write(chunk) ? Promise.resolve() : new Promise((resolve) => res.once('drain', resolve));

  /** Streams one collection as a JSON array value, one document at a time. */
  async function streamArray(key, query) {
    await write(`"${key}":[`);
    let first = true;
    const cursor = query.lean().cursor();
    try {
      for await (const doc of cursor) {
        await write(first ? JSON.stringify(doc) : ',' + JSON.stringify(doc));
        first = false;
      }
    } finally {
      await cursor.close();
    }
    await write(']');
  }

  try {
    await write('{');
    await write(`"exported_at":${JSON.stringify(new Date().toISOString())},`);
    await write('"format_version":1,');
    await write(`"organization":${JSON.stringify({
      id: org._id, name: org.name, currency: org.currency,
      plan: org.plan, status: org.status, created_at: org.createdAt,
    })},`);
    await write(`"counts":${JSON.stringify(counts)},`);

    await streamArray('sites', Site.find({ orgId }));
    await write(',');
    await streamArray('inventory', Inventory.find({ orgId }));
    await write(',');
    await streamArray('slips', Slip.find({ orgId }));
    await write(',');
    await streamArray('orders', Order.find({ orgId }));
    await write(',');
    // Credentials and push tokens are deliberately not exported.
    await streamArray('users', User.find(
      { orgId },
      '-password -otpHash -otpExpiry -otpAttempts -fcmTokens -fcmToken -tokenVersion'
    ));
    await write(',');
    await streamArray('audit_log',
      AuditLog.find({ orgId }).sort({ createdAt: -1 }).limit(AUDIT_EXPORT_LIMIT));
    await write('}');

    audit.record(req, {
      action: 'org.export',
      entity: 'organization',
      entity_id: org._id,
      entity_label: org.name,
      after: counts,
    });

    return res.end();
  } catch (err) {
    // The headers and an opening brace are already on the wire, so there is no way
    // to send a 500 body. Destroying the socket is the only honest signal: the
    // client sees a truncated response and a connection error rather than a JSON
    // document that silently stops early and looks complete.
    console.error('[ORG EXPORT] failed mid-stream', err);
    return res.destroy(err);
  }
});

// ─── DELETE /api/org ──────────────────────────────────────────────────────────
// Deletes the whole organisation and everything in it. Requires the owner to type
// the company name back, because there is no undo and this is the one action that
// destroys a customer's entire history.
router.delete('/',ownerOnly, async (req, res) => {
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
