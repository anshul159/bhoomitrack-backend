const express = require('express');
const router = express.Router();
// No `auth` here on purpose — applied at the mount in server.js (PF-007). Note that
// org is mounted with `auth, requireOrgId` but WITHOUT requireActiveOrg, so a lapsed
// customer can still see what they owe and export their data.
const { ownerOnly, requireSuperAdmin } = require('../middleware/roles');
const Organization = require('../models/Organization');
const Site = require('../models/Site');
const Inventory = require('../models/Inventory');
const Slip = require('../models/Slip');
const Order = require('../models/Order');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const audit = require('../utils/audit');
const { isNonEmptyString, isObjectId } = require('../utils/validate');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const mongoose = require('mongoose');
// Required as a module rather than destructured, so the call site is late-bound.
// A destructured reference is captured at require time and cannot be stood in
// for — which would leave the mail behaviour here, the part most worth pinning,
// untestable.
const mailer = require('../utils/mailer');
const { captureError } = require('../utils/observability');

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


// ─── Super Admin transfer (WEB-APP-PLAN §7.4) ─────────────────────────────────
//
// The most consequential action in the product: it moves who may grant web
// access and who may transfer the role again. Guarded by an emailed code so
// possession of a logged-in session is not enough on its own.

const TRANSFER_TTL_MINUTES = 15;
const TRANSFER_MAX_ATTEMPTS = 5;

/** A pending transfer that has expired is not pending. */
const transferLive = (t) => Boolean(t && t.expiresAt && t.expiresAt > new Date());

// POST /api/org/super-admin/transfer/request
router.post('/super-admin/transfer/request', requireSuperAdmin, async (req, res) => {
  try {
    const { toUserId } = req.body;
    if (!isObjectId(toUserId)) return res.status(400).json({ success: false, message: 'Invalid user id' });

    const org = await Organization.findById(req.user.orgId);
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });

    const target = await User.findOne({ _id: toUserId, orgId: req.user.orgId, deletedAt: null });
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (String(target._id) === String(req.user.id)) {
      return res.status(400).json({ success: false, message: 'You are already the Super Admin' });
    }
    if (target.role !== 'owner') {
      return res.status(400).json({ success: false, message: 'Only an owner can become Super Admin' });
    }
    if (target.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'That owner is not approved yet' });
    }

    const current = await User.findById(req.user.id).select('email name');
    if (!current?.email) {
      // The code has to reach the OUTGOING holder. With no address there is no
      // way to prove they agreed, and no safe way to proceed.
      return res.status(400).json({ success: false, message: 'Your account has no email address to send the code to' });
    }

    // crypto.randomInt is uniform; Math.random is not, and this is a credential.
    const code = String(crypto.randomInt(100000, 1000000));

    // Send BEFORE storing. utils/mailer.js throws in production when SMTP is
    // missing but WARNS AND RETURNS FALSE in development — so a confirm step
    // that accepted a code which was never sent would be a hole. `false` is a
    // failure here, not a success.
    let delivered = false;
    try {
      delivered = await mailer.sendSuperAdminTransferEmail(
        current.email, current.name, target.name, code, TRANSFER_TTL_MINUTES
      );
    } catch (mailErr) {
      captureError(mailErr, { route: 'org.transferRequest' });
      return res.status(502).json({ success: false, message: `Could not send the confirmation code: ${mailErr.message}` });
    }
    if (!delivered) {
      return res.status(502).json({
        success: false,
        code: 'mail_not_configured',
        message: 'Email is not configured on this server, so the confirmation code could not be sent.',
      });
    }

    org.pendingTransfer = {
      toUserId: target._id,
      requestedBy: req.user.id,
      otpHash: await bcrypt.hash(code, 10),
      expiresAt: new Date(Date.now() + TRANSFER_TTL_MINUTES * 60 * 1000),
      attempts: 0,
    };
    await org.save();

    audit.record(req, {
      action: 'org.super_admin_transfer_requested', entity: 'organization',
      entity_id: org._id, entity_label: org.name,
      after: { toUserId: String(target._id), toName: target.name },
    });

    return res.json({
      success: true,
      message: `A confirmation code has been emailed to you. It expires in ${TRANSFER_TTL_MINUTES} minutes.`,
      data: { to_name: target.name, expires_in_minutes: TRANSFER_TTL_MINUTES, sent_to: current.email },
    });
  } catch (err) {
    captureError(err, { route: 'org.transferRequest' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/org/super-admin/transfer — what is in flight, if anything.
router.get('/super-admin/transfer', requireSuperAdmin, async (req, res) => {
  try {
    const org = await Organization.findById(req.user.orgId);
    const t = org?.pendingTransfer;
    if (!transferLive(t)) return res.json({ success: true, data: null });
    const target = await User.findById(t.toUserId).select('name email').lean();
    return res.json({
      success: true,
      data: {
        to_user_id: String(t.toUserId),
        to_name: target?.name || 'Unknown',
        expires_at: t.expiresAt,
        attempts_left: Math.max(0, TRANSFER_MAX_ATTEMPTS - (t.attempts || 0)),
      },
    });
  } catch (err) {
    captureError(err, { route: 'org.transferStatus' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/org/super-admin/transfer/cancel
router.post('/super-admin/transfer/cancel', requireSuperAdmin, async (req, res) => {
  try {
    const org = await Organization.findById(req.user.orgId);
    if (!org) return res.status(404).json({ success: false, message: 'Organisation not found' });
    if (!org.pendingTransfer) return res.json({ success: true, message: 'Nothing to cancel' });

    org.pendingTransfer = null;
    await org.save();
    audit.record(req, {
      action: 'org.super_admin_transfer_cancelled', entity: 'organization',
      entity_id: org._id, entity_label: org.name,
    });
    return res.json({ success: true, message: 'Transfer cancelled' });
  } catch (err) {
    captureError(err, { route: 'org.transferCancel' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * The swap itself.
 *
 * A single transaction is the right shape and is what Atlas gives us. The test
 * harness runs a STANDALONE mongod, where transactions are unsupported, so this
 * falls back to ordered sequential writes rather than pretending.
 *
 * The order of the fallback is the whole point: PROMOTE FIRST. A failure between
 * the two writes then leaves two super admins — an odd state, but both are
 * trusted owners and either can finish the job. Demoting first would risk ZERO
 * super admins, which nobody in the organisation could repair without database
 * access.
 */
async function applyTransfer(org, currentId, targetId) {
  const promote = { role: 'super_admin', $inc: { tokenVersion: 1 } };
  // webAppAccess: true on the outgoing holder is not a nicety. Without it they
  // instantly lose the console they just handed over, and the only person who
  // could give it back is the one they just promoted.
  const demote = { role: 'owner', webAppAccess: true, $inc: { tokenVersion: 1 } };

  const writes = async (session) => {
    const opts = session ? { session } : {};
    await User.updateOne({ _id: targetId }, promote, opts);
    await User.updateOne({ _id: currentId }, demote, opts);
    await Organization.updateOne(
      { _id: org._id }, { superAdminId: targetId, pendingTransfer: null }, opts
    );
  };

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() => writes(session));
    return 'transaction';
  } catch (err) {
    const unsupported = /replica set|Transaction numbers|not supported/i.test(err.message || '');
    if (!unsupported) throw err;
  } finally {
    await session.endSession();
  }
  await writes(null);
  return 'sequential';
}

// POST /api/org/super-admin/transfer/confirm
router.post('/super-admin/transfer/confirm', requireSuperAdmin, async (req, res) => {
  try {
    const { code } = req.body;
    if (!isNonEmptyString(code)) return res.status(400).json({ success: false, message: 'Code required' });

    const org = await Organization.findById(req.user.orgId);
    if (!org || !transferLive(org.pendingTransfer)) {
      return res.status(400).json({ success: false, message: 'No transfer is pending, or it has expired' });
    }

    const t = org.pendingTransfer;
    if ((t.attempts || 0) >= TRANSFER_MAX_ATTEMPTS) {
      org.pendingTransfer = null;
      await org.save();
      return res.status(429).json({ success: false, message: 'Too many attempts. Start the transfer again.' });
    }

    if (!(await bcrypt.compare(String(code), t.otpHash))) {
      org.pendingTransfer.attempts = (t.attempts || 0) + 1;
      await org.save();
      return res.status(400).json({
        success: false,
        message: 'That code is not right',
        data: { attempts_left: TRANSFER_MAX_ATTEMPTS - org.pendingTransfer.attempts },
      });
    }

    const target = await User.findOne({ _id: t.toUserId, orgId: org._id, deletedAt: null }).select('name role');
    if (!target || target.role !== 'owner') {
      org.pendingTransfer = null;
      await org.save();
      return res.status(409).json({ success: false, message: 'That owner is no longer eligible. Start again.' });
    }

    const mode = await applyTransfer(org, req.user.id, target._id);

    audit.record(req, {
      action: 'org.super_admin_transfer', entity: 'organization',
      entity_id: org._id, entity_label: org.name,
      before: { superAdminId: String(req.user.id) },
      after: { superAdminId: String(target._id), applied: mode },
    });

    return res.json({
      success: true,
      // tokenVersion++ on both is what makes this immediate. It also ends their
      // Android sessions, which is correct and a surprise if unannounced.
      message: `${target.name} is now the Super Admin. You are both signed out and will need to log in again.`,
      data: { new_super_admin: { id: target._id, name: target.name } },
    });
  } catch (err) {
    captureError(err, { route: 'org.transferConfirm' });
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
