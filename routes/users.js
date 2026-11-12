const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const Site = require('../models/Site');
const Organization = require('../models/Organization');
const auth = require('../middleware/auth');
const { ownerOnly, requireSuperAdmin, mayUseWebConsole } = require('../middleware/roles');
const { makeToken, WEB_TOKEN_TTL } = require('../utils/token');
const { validatePassword } = require('../utils/password');
const { sendPasswordResetEmail, isConfigured: mailConfigured } = require('../utils/mailer');
const { resolveSite } = require('../utils/site');
const audit = require('../utils/audit');
const { captureError } = require('../utils/observability');
const { isNonEmptyString, isObjectId, isAvatarDataUri, AVATAR_MAX_CHARS } = require('../utils/validate');
const { respondIfDuplicate } = require('../utils/duplicateKey');
const {
  UNITS,
  effectiveMaterialDefaults,
  normaliseMaterialDefaults,
} = require('../utils/materialDefaults');

const OTP_TTL_MINUTES = 15;
const OTP_MAX_ATTEMPTS = 5;

const userToResponse = (user, token, extra) => ({
  success: true,
  message: 'OK',
  token: token || null,
  user: {
    id: user._id,
    name: user.name,
    phone: user.phone || '',
    email: user.email || '',
    role: user.role,
    site_name: user.site_name || '',
    site_ids: (user.site_ids || []).map(String),
    approved: user.status === 'approved',
    status: user.status,
    // `avatar` is select:false, so it is only present when the caller explicitly
    // asked for it. Undefined must not become the string "undefined" on a client
    // that renders whatever it is handed.
    avatar: user.avatar || '',
    ...(extra || {}),
  }
});

// Live accounts only — a deleted account must not be able to log back in (ENH-013).
const live = (extra = {}) => ({ deletedAt: null, ...extra });

// ─── POST /api/users/login ────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!isNonEmptyString(email) || !isNonEmptyString(password, 128)) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }
    const user = await User.findOne(live({ email: email.toLowerCase(), role: { $in: ['owner', 'super_admin'] } })).select('+avatar');
    if (!user || !user.password) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    return res.json(userToResponse(user, makeToken(user)));
  } catch (err) {
    console.error(err);
    captureError(err, { route: 'users.login' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/manager-login ───────────────────────────────────────────
// ─── POST /api/users/web-login ────────────────────────────────────────────────
//
// The web console's door. Tightening `ownerOnly` instead would have been an
// outage: it guards 28 routes the Android app calls every day, and narrowing it
// locks owners out of their phones. One new endpoint, no existing route touched.
//
// The credential failure is deliberately identical to /login's — the entitlement
// refusal below is only reachable AFTER the password has been proved, so it
// cannot be used to discover who has an account.
router.post('/web-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!isNonEmptyString(email) || !isNonEmptyString(password, 128)) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }
    const user = await User.findOne(live({ email: email.toLowerCase(), role: { $in: ['owner', 'super_admin'] } })).select('+avatar');
    if (!user || !user.password) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    if (!mayUseWebConsole(user)) {
      return res.status(403).json({
        success: false,
        code: 'web_access_not_granted',
        message: 'Ask your Super Admin for web access.',
      });
    }

    // A shorter life than the app's 30 days — see utils/token.js.
    return res.json(userToResponse(user, makeToken(user, WEB_TOKEN_TTL), {
      is_super_admin: user.role === 'super_admin',
      web_app_access: mayUseWebConsole(user),
    }));
  } catch (err) {
    console.error(err);
    captureError(err, { route: 'users.webLogin' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/manager-login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!isNonEmptyString(phone, 20) || !isNonEmptyString(password, 128)) {
      return res.status(400).json({ success: false, message: 'Phone and password required' });
    }
    const user = await User.findOne(live({ phone, role: 'manager' })).select('+avatar');
    if (!user) return res.status(401).json({ success: false, message: 'Invalid phone number or password' });
    if (!user.password) return res.status(401).json({ success: false, message: 'No password set. Please register via invite code.' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ success: false, message: 'Invalid phone number or password' });
    return res.json(userToResponse(user, makeToken(user)));
  } catch (err) {
    console.error(err);
    captureError(err, { route: 'users.managerLogin' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/forgot-password ─────────────────────────────────────────
// Emails a single-use code (ENH-001).
//
// Three things changed from the version that wrote the code to the Render log:
// the code is delivered to the registered address, it is stored only as a bcrypt
// hash, and the response is identical whether or not the account exists — so this
// endpoint can no longer be used to find out who has an account.
router.post('/forgot-password', async (req, res) => {
  const genericResponse = {
    success: true,
    message: 'If an account exists for that email, a reset code is on its way.',
  };

  try {
    const { email } = req.body;
    if (!isNonEmptyString(email)) return res.status(400).json({ success: false, message: 'Email required' });

    const user = await User.findOne(live({ email: email.toLowerCase(), role: { $in: ['owner', 'super_admin'] } }));
    if (!user) return res.json(genericResponse);

    // crypto.randomInt is uniform; Math.random is not, and this is a credential.
    const resetCode = String(crypto.randomInt(100000, 1000000));
    const tokenExpiry = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await User.findByIdAndUpdate(user._id, {
      otpHash: await bcrypt.hash(resetCode, 10),
      otpExpiry: tokenExpiry,
      otpAttempts: 0,
    });

    try {
      await sendPasswordResetEmail(user.email, user.name, resetCode, OTP_TTL_MINUTES);
    } catch (mailErr) {
      // Report it, but never leak whether the address exists by changing the reply.
      console.error('[FORGOT-PASSWORD] Email send failed:', mailErr.message);
      captureError(mailErr, { route: 'users.forgotPassword' });
    }

    return res.json(genericResponse);
  } catch (err) {
    console.error(err);
    captureError(err, { route: 'users.forgotPassword' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/reset-password ──────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;
    if (!isNonEmptyString(email) || !isNonEmptyString(token, 10) || !isNonEmptyString(newPassword, 128)) {
      return res.status(400).json({ success: false, message: 'Email, token and new password required' });
    }

    const user = await User.findOne(live({ email: email.toLowerCase(), role: { $in: ['owner', 'super_admin'] } }));
    // Same message for "no such account" and "wrong code" — see forgot-password.
    const invalid = { success: false, message: 'Invalid or expired reset code' };
    if (!user || !user.otpHash) return res.status(400).json(invalid);

    if (user.otpExpiry && new Date() > user.otpExpiry) {
      await User.findByIdAndUpdate(user._id, { otpHash: null, otpExpiry: null, otpAttempts: 0 });
      return res.status(400).json({ success: false, message: 'Reset code expired. Please request a new one.' });
    }

    // Bound the guesses against one issued code, independently of the IP-based
    // rate limiter.
    if ((user.otpAttempts || 0) >= OTP_MAX_ATTEMPTS) {
      await User.findByIdAndUpdate(user._id, { otpHash: null, otpExpiry: null, otpAttempts: 0 });
      return res.status(400).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
    }

    const codeMatches = await bcrypt.compare(token, user.otpHash);
    if (!codeMatches) {
      await User.findByIdAndUpdate(user._id, { $inc: { otpAttempts: 1 } });
      return res.status(400).json(invalid);
    }

    const policy = validatePassword(newPassword, { name: user.name, email: user.email, phone: user.phone });
    if (!policy.ok) return res.status(400).json({ success: false, message: policy.message });

    const hashed = await bcrypt.hash(newPassword, 10);
    await User.findByIdAndUpdate(user._id, {
      password: hashed,
      otpHash: null,
      otpExpiry: null,
      otpAttempts: 0,
      // Anyone holding a token for this account loses it — a reset is exactly the
      // moment you want existing sessions gone (ENH-012).
      $inc: { tokenVersion: 1 },
    });

    return res.json({ success: true, message: 'Password reset successfully. You can now log in.' });
  } catch (err) {
    console.error(err);
    captureError(err, { route: 'users.resetPassword' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/change-password ─────────────────────────────────────────
router.post('/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!isNonEmptyString(currentPassword, 128) || !isNonEmptyString(newPassword, 128)) {
      return res.status(400).json({ success: false, message: 'Current and new password are required' });
    }

    const user = await User.findById(req.user.id);
    if (!user || user.deletedAt) return res.status(404).json({ success: false, message: 'Account not found' });

    const match = await bcrypt.compare(currentPassword, user.password || '');
    if (!match) return res.status(401).json({ success: false, message: 'Current password is incorrect' });

    const policy = validatePassword(newPassword, { name: user.name, email: user.email, phone: user.phone });
    if (!policy.ok) return res.status(400).json({ success: false, message: policy.message });

    user.password = await bcrypt.hash(newPassword, 10);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    // The caller keeps working; every other device is signed out.
    return res.json({ success: true, message: 'Password changed', token: makeToken(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/logout ───────────────────────────────────────────────────
// Invalidates every outstanding token for this user (ENH-012), and drops the
// calling device's push token so a signed-out phone stops receiving alerts.
router.post('/logout', auth, async (req, res) => {
  try {
    const update = { $inc: { tokenVersion: 1 } };
    if (isNonEmptyString(req.body?.fcmToken, 500)) {
      update.$pull = { fcmTokens: { token: req.body.fcmToken } };
    }
    await User.findByIdAndUpdate(req.user.id, update);
    return res.json({ success: true, message: 'Logged out' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/users/me ────────────────────────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  try {
    // +avatar because the field is select:false — /me is one of the few places
    // that genuinely wants it.
    const user = await User.findById(req.user.id).select('+avatar').lean();
    if (!user || user.deletedAt) return res.status(404).json({ success: false, message: 'Account not found' });
    return res.json(userToResponse(user, null));
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/users/me/avatar ─────────────────────────────────────────────────
// Set the signed-in user's profile picture. The image arrives inline as a data
// URI; see models/User.js for why it is stored on the document rather than in an
// object store.
//
// The size and format checks are enforced here and not merely on the device: the
// client downscales as a courtesy to the network, but nothing stops a caller from
// posting a 900 KB PNG straight at this route, and a user document that grows
// without bound is a slow outage rather than a fast one.
router.put('/me/avatar', auth, async (req, res) => {
  try {
    const { avatar } = req.body;
    if (!isAvatarDataUri(avatar)) {
      return res.status(400).json({
        success: false,
        message: `Send a jpeg, png or webp image as a data URI, at most ${Math.floor(AVATAR_MAX_CHARS / 1024)} KB encoded.`,
      });
    }

    const user = await User.findById(req.user.id);
    if (!user || user.deletedAt) return res.status(404).json({ success: false, message: 'Account not found' });

    user.avatar = avatar;
    await user.save();

    // Deliberately not audited with a before/after: the payload is the image, and
    // writing two copies of it into the audit log on every change would grow that
    // collection by megabytes for no investigative value (PF-010).
    audit.record(req, {
      action: 'user.avatar.set',
      entity: 'user',
      entity_id: user._id,
      entity_label: user.name,
    });

    return res.json({ success: true, message: 'Profile picture updated', avatar: user.avatar });
  } catch (err) {
    console.error('[AVATAR SET]', err);
    captureError(err, { route: 'users.setAvatar' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── DELETE /api/users/me/avatar ──────────────────────────────────────────────
// Remove the picture and fall back to initials. Idempotent: removing a picture
// that is already absent succeeds, because the caller's intent is satisfied.
router.delete('/me/avatar', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.deletedAt) return res.status(404).json({ success: false, message: 'Account not found' });

    user.avatar = '';
    await user.save();

    audit.record(req, {
      action: 'user.avatar.clear',
      entity: 'user',
      entity_id: user._id,
      entity_label: user.name,
    });

    return res.json({ success: true, message: 'Profile picture removed', avatar: '' });
  } catch (err) {
    console.error('[AVATAR CLEAR]', err);
    captureError(err, { route: 'users.clearAvatar' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/users/me/material-defaults ──────────────────────────────────────
// The signed-in user's Create Site material list (ENH-097).
//
// `units` rides along so the app's unit pickers can gain an option without a store
// release — the list is a suggestion, not an enum (see utils/materialDefaults.js).
router.get('/me/material-defaults', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('materialDefaults deletedAt').lean();
    if (!user || user.deletedAt) return res.status(404).json({ success: false, message: 'Account not found' });

    return res.json({
      success: true,
      message: 'OK',
      defaults: effectiveMaterialDefaults(user.materialDefaults),
      units: UNITS,
    });
  } catch (err) {
    console.error('[MATERIAL DEFAULTS GET]', err);
    captureError(err, { route: 'users.getMaterialDefaults' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/users/me/material-defaults ──────────────────────────────────────
// Replace the list wholesale. Not a PATCH: the client owns a small ordered list it
// has entirely in hand, and merging row-by-row would need stable ids for rows the
// user thinks of as "the Cement one".
//
// An empty array is a legitimate answer — someone who tracks only materials they
// type in per site — and is stored as `[]` rather than unset, which is exactly the
// distinction the model's `default: undefined` preserves.
router.put('/me/material-defaults', auth, async (req, res) => {
  try {
    const parsed = normaliseMaterialDefaults(req.body?.defaults);
    if (!parsed.ok) return res.status(400).json({ success: false, message: parsed.message });

    const user = await User.findById(req.user.id);
    if (!user || user.deletedAt) return res.status(404).json({ success: false, message: 'Account not found' });

    const before = Array.isArray(user.materialDefaults) ? user.materialDefaults.length : null;
    user.materialDefaults = parsed.value;
    await user.save();

    // Counts, not contents. The interesting fact is that someone changed their form;
    // writing twelve material names into the audit log on every tweak would grow
    // that collection for no investigative value (the same reasoning as avatars).
    audit.record(req, {
      action: 'user.material_defaults.set',
      entity: 'user',
      entity_id: user._id,
      entity_label: user.name,
      before: { materials: before },
      after: { materials: parsed.value.length },
    });

    return res.json({
      success: true,
      message: 'Site defaults saved',
      defaults: effectiveMaterialDefaults(user.materialDefaults),
      units: UNITS,
    });
  } catch (err) {
    console.error('[MATERIAL DEFAULTS SET]', err);
    captureError(err, { route: 'users.setMaterialDefaults' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET / PUT /api/users/me/notifications ────────────────────────────────────
// An owner's own notification choices (v2): the daily summary and the
// large-payment alert. Both start off; nothing here is pushed to anyone who did
// not ask for it. Per person rather than per company, because two owners of one
// company can reasonably want different things in their pocket.
//
// Owners only — managers receive neither notification.

const DEFAULT_SUMMARY_HOUR = 20;
const DEFAULT_PAYMENT_THRESHOLD = 10000;

function notificationSettings(user) {
  const p = user.notificationPrefs || {};
  return {
    daily_summary: Boolean(p.dailySummary),
    daily_summary_hour: Number.isInteger(p.dailySummaryHour) ? p.dailySummaryHour : DEFAULT_SUMMARY_HOUR,
    large_payment_alert: Boolean(p.largePaymentAlert),
    large_payment_threshold: typeof p.largePaymentThreshold === 'number' ? p.largePaymentThreshold : DEFAULT_PAYMENT_THRESHOLD,
    // The hour is India time; said out loud so no client has to assume it.
    timezone: 'Asia/Kolkata',
  };
}

const isOwnerLike = (role) => role === 'owner' || role === 'super_admin';

router.get('/me/notifications', auth, async (req, res) => {
  try {
    if (!isOwnerLike(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Notification settings are for owners' });
    }
    const user = await User.findById(req.user.id).select('notificationPrefs deletedAt').lean();
    if (!user || user.deletedAt) return res.status(404).json({ success: false, message: 'Account not found' });
    return res.json({ success: true, message: 'OK', data: notificationSettings(user) });
  } catch (err) {
    console.error('[NOTIFICATIONS GET]', err);
    captureError(err, { route: 'users.getNotifications' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Partial: send only what changed. Each field is checked on its own, and nothing
// is saved unless every field sent is valid.
router.put('/me/notifications', auth, async (req, res) => {
  try {
    if (!isOwnerLike(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Notification settings are for owners' });
    }
    const body = req.body || {};
    const set = {};

    for (const [field, path] of [['daily_summary', 'dailySummary'], ['large_payment_alert', 'largePaymentAlert']]) {
      if (body[field] === undefined) continue;
      if (typeof body[field] !== 'boolean') {
        return res.status(400).json({ success: false, message: `${field} must be true or false` });
      }
      set[`notificationPrefs.${path}`] = body[field];
    }

    if (body.daily_summary_hour !== undefined) {
      const hour = body.daily_summary_hour;
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        return res.status(400).json({ success: false, message: 'The summary hour must be a whole hour from 0 to 23' });
      }
      set['notificationPrefs.dailySummaryHour'] = hour;
    }

    if (body.large_payment_threshold !== undefined) {
      const amount = Number(body.large_payment_threshold);
      if (typeof body.large_payment_threshold !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 1e9) {
        return res.status(400).json({ success: false, message: 'The alert amount must be more than ₹0' });
      }
      set['notificationPrefs.largePaymentThreshold'] = Number(amount.toFixed(2));
    }

    if (Object.keys(set).length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to change' });
    }

    const user = await User.findOneAndUpdate(
      { _id: req.user.id, deletedAt: null },
      { $set: set },
      { new: true, runValidators: true, projection: 'notificationPrefs' }
    ).lean();
    if (!user) return res.status(404).json({ success: false, message: 'Account not found' });
    return res.json({ success: true, message: 'Notification settings saved', data: notificationSettings(user) });
  } catch (err) {
    console.error('[NOTIFICATIONS SET]', err);
    captureError(err, { route: 'users.setNotifications' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── DELETE /api/users/me ─────────────────────────────────────────────────────
// Account deletion (ENH-013). Google Play's data-safety declaration expects an
// in-app deletion route and the DPDP Act gives users an erasure right.
//
// Soft delete with a retention window: the account stops working immediately —
// login blocked, tokens revoked, credentials scrubbed — and the row is purged
// after RETENTION_DAYS. The window exists because slips and inventory history
// reference the person, and an accidental deletion that shredded a site's audit
// trail would be unrecoverable.
const RETENTION_DAYS = Number(process.env.DELETION_RETENTION_DAYS || 30);

router.delete('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.deletedAt) return res.status(404).json({ success: false, message: 'Account not found' });

    // The last owner cannot leave the organisation stranded with data nobody can
    // reach. They must hand over first, or delete the organisation itself.
    if (user.role === 'owner' || user.role === 'super_admin') {
      const otherOwners = await User.countDocuments({
        orgId: user.orgId,
        role: { $in: ['owner', 'super_admin'] },
        _id: { $ne: user._id },
        deletedAt: null,
      });
      if (otherOwners === 0) {
        return res.status(400).json({
          success: false,
          code: 'last_owner',
          message: 'You are the only owner. Add another owner first, or delete the whole company from Settings.',
        });
      }
    }

    const now = new Date();
    user.deletedAt = now;
    user.purgeAfter = new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
    user.password = '';
    user.otpHash = null;
    user.otpExpiry = null;
    user.fcmTokens = [];
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    audit.record(req, {
      action: 'user.delete',
      entity: 'user',
      entity_id: user._id,
      entity_label: user.name,
      after: { deletedAt: now, purgeAfter: user.purgeAfter },
    });

    return res.json({
      success: true,
      message: `Your account has been deleted. Remaining data is removed after ${RETENTION_DAYS} days.`,
      purge_after: user.purgeAfter,
    });
  } catch (err) {
    console.error('[DELETE ACCOUNT]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/users/owner ─────────────────────────────────────────────────────
// Manager: get the owner/super_admin for their org
router.get('/owner', auth, async (req, res) => {
  try {
    // Deterministic, in this order (PF-015):
    //   1. the organisation's registered super admin
    //   2. failing that, the longest-standing live owner
    //
    // This used to be an unordered findOne, so in a company with more than one owner
    // it returned whichever document the database happened to hand back first. A
    // manager's message went to an arbitrary owner and was invisible to the others,
    // with nothing to tell either party — and orgs reach two owners through the
    // product's own owner-invite flow.
    const org = await Organization.findById(req.user.orgId).select('superAdminId').lean();

    let owner = null;
    if (org?.superAdminId) {
      owner = await User.findOne(live({ _id: org.superAdminId, orgId: req.user.orgId }));
    }
    if (!owner) {
      owner = await User.findOne(live({
        role: { $in: ['owner', 'super_admin'] },
        orgId: req.user.orgId,
      })).sort({ createdAt: 1, _id: 1 });
    }

    if (!owner) return res.status(404).json({ success: false, message: 'No owner found for your org' });
    return res.json({ success: true, data: { id: owner._id, name: owner.name, phone: owner.phone || '', site_name: '' } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/users/fcm-token ─────────────────────────────────────────────────
// Registers this device's push token (ENH-014). A person may be signed in on a
// phone and a tablet; both now receive alerts, where previously the most recent
// login silently stole push from the other.
router.put('/fcm-token', auth, async (req, res) => {
  try {
    const { token, platform } = req.body;
    if (!isNonEmptyString(token, 500)) return res.status(400).json({ success: false, message: 'Token is required' });

    // One row per token: refresh if known, append if new.
    const updated = await User.updateOne(
      { _id: req.user.id, 'fcmTokens.token': token },
      { $set: { 'fcmTokens.$.lastSeenAt': new Date(), 'fcmTokens.$.platform': platform || 'android' } }
    );

    if (updated.matchedCount === 0) {
      await User.updateOne(
        { _id: req.user.id },
        {
          $push: {
            fcmTokens: {
              $each: [{ token, platform: platform || 'android', lastSeenAt: new Date() }],
              // Keep the most recent devices only, so a person who reinstalls
              // repeatedly does not accumulate dead tokens forever.
              $slice: -10,
            }
          }
        }
      );
    }

    return res.json({ success: true, message: 'Token registered' });
  } catch (err) {
    console.error('[FCM TOKEN]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── DELETE /api/users/fcm-token ──────────────────────────────────────────────
router.delete('/fcm-token', auth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!isNonEmptyString(token, 500)) return res.status(400).json({ success: false, message: 'Token is required' });
    await User.updateOne({ _id: req.user.id }, { $pull: { fcmTokens: { token } } });
    return res.json({ success: true, message: 'Token removed' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/users/managers ──────────────────────────────────────────────────
// Owner only: list all approved managers in this org
// ─── GET /api/users/owners ────────────────────────────────────────────────────
// Every owner and the super admin, for the console's Owners screen. Distinct from
// the existing GET /owner, which returns ONE owner for chat routing and is called
// by the app — that route is left exactly as it is.
router.get('/owners', auth, ownerOnly, async (req, res) => {
  try {
    const users = await User.find(live({ orgId: req.user.orgId, role: { $in: ['owner', 'super_admin'] } }))
      .select('name email role webAppAccess status createdAt')
      .sort({ createdAt: 1 })
      .lean();

    // No `last_active` column: User has no such field and inventing one here
    // would mean inventing the data behind it.
    return res.json({
      success: true,
      data: users.map((u) => ({
        id: u._id,
        name: u.name,
        email: u.email || '',
        role: u.role,
        is_super_admin: u.role === 'super_admin',
        web_app_access: u.role === 'super_admin' || Boolean(u.webAppAccess),
        status: u.status,
        created_at: u.createdAt,
      })),
    });
  } catch (err) {
    captureError(err, { route: 'users.owners' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/users/:userId/web-access ────────────────────────────────────────
// Super admin only. The super admin holds web access implicitly and cannot be
// toggled; an owner granted it cannot pass it on.
//
// No tokenVersion bump: middleware/auth.js reads webAppAccess on every request,
// so a revocation bites on the next call WITHOUT also ending the owner's Android
// session, which a bump would do for a web-only change.
router.put('/:userId/web-access', auth, requireSuperAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isObjectId(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });
    if (typeof req.body.enabled !== 'boolean') {
      return res.status(400).json({ success: false, message: '`enabled` must be true or false' });
    }

    const target = await User.findOne(live({ _id: userId, orgId: req.user.orgId }));
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (target.role === 'super_admin') {
      return res.status(400).json({ success: false, message: 'The Super Admin always has web access' });
    }
    if (target.role !== 'owner') {
      return res.status(400).json({ success: false, message: 'Only an owner can be given web access' });
    }

    const before = Boolean(target.webAppAccess);
    target.webAppAccess = req.body.enabled;
    await target.save();

    audit.record(req, {
      action: req.body.enabled ? 'user.grant_web_access' : 'user.revoke_web_access',
      entity: 'user', entity_id: target._id, entity_label: target.name,
      before: { webAppAccess: before }, after: { webAppAccess: target.webAppAccess },
    });

    return res.json({
      success: true,
      message: req.body.enabled
        ? `${target.name} can now sign in to the web console`
        : `${target.name} can no longer sign in to the web console`,
      data: { id: target._id, name: target.name, web_app_access: target.webAppAccess },
    });
  } catch (err) {
    captureError(err, { route: 'users.webAccess' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// `scope=all` widens this to pending and unassigned managers and adds `status`.
// The DEFAULT response is deliberately untouched: the Android app calls this
// route every day, and one API is about to have two clients. A new parameter is
// safe where a changed default is not.
router.get('/managers', auth, ownerOnly, async (req, res) => {
  try {
    const all = req.query.scope === 'all';
    const filter = { role: 'manager', orgId: req.user.orgId };
    if (!all) filter.status = 'approved';

    const managers = await User.find(live(filter)).sort({ name: 1 }).lean();

    // Resolve assigned site names in one query rather than per manager.
    const allIds = [...new Set(managers.flatMap(m => (m.site_ids || []).map(String)))];
    const sites = allIds.length
      ? await Site.find({ _id: { $in: allIds }, orgId: req.user.orgId }, 'name').lean()
      : [];
    const siteNames = Object.fromEntries(sites.map(s => [String(s._id), s.name]));

    const data = managers.map(m => {
      const names = (m.site_ids || []).map(id => siteNames[String(id)]).filter(Boolean);
      return {
        id: m._id,
        name: m.name,
        phone: m.phone || '',
        site_name: m.site_name || names[0] || '',
        site_ids: (m.site_ids || []).map(String),
        site_names: names.length ? names : (m.site_name ? [m.site_name] : []),
        created_at: m.createdAt,
        assigned_at: m.assignedAt || null,
        // Only under scope=all, so the default payload keeps its exact shape.
        ...(all ? { status: m.status, assigned: (m.site_ids || []).length > 0 } : {}),
      };
    });
    return res.json({ success: true, message: 'OK', data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/users/assign-site/:userId ───────────────────────────────────────
// Owner only. Accepts either:
//   { siteName: "Site A" }                  replace assignments with this one
//   { siteName: "Site A", add: true }       add to existing assignments
//   { siteNames: ["Site A", "Site B"] }     set the full list (ENH-016)
//
// The singular form keeps its original replace semantics so app builds already in
// the field behave exactly as before.
router.put('/assign-site/:userId', auth, ownerOnly, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isObjectId(userId)) return res.status(400).json({ success: false, message: 'Invalid manager id' });

    const { siteName, siteNames, add } = req.body;
    const requested = Array.isArray(siteNames) && siteNames.length > 0
      ? siteNames
      : (isNonEmptyString(siteName, 200) ? [siteName] : null);

    if (!requested) return res.status(400).json({ success: false, message: 'siteName or siteNames is required' });
    if (requested.length > 50) return res.status(400).json({ success: false, message: 'Too many sites' });

    const resolved = [];
    for (const s of requested) {
      const site = await resolveSite(s, req.user.orgId);
      if (!site) return res.status(404).json({ success: false, message: `Site "${s}" not found` });
      resolved.push(site);
    }

    const manager = await User.findOne({ _id: userId, role: 'manager', orgId: req.user.orgId, deletedAt: null });
    if (!manager) return res.status(404).json({ success: false, message: 'Manager not found' });

    const before = {
      site_ids: (manager.site_ids || []).map(String),
      site_name: manager.site_name,
    };

    const appending = add === true && Array.isArray(siteNames) === false;
    const nextIds = appending
      ? [...new Set([...(manager.site_ids || []).map(String), ...resolved.map(s => String(s._id))])]
      : [...new Set(resolved.map(s => String(s._id)))];

    manager.site_ids = nextIds;
    // `site_name` tracks the first assignment, for app builds that read one site.
    const firstSite = resolved[0];
    manager.site_name = appending && manager.site_name ? manager.site_name : firstSite.name;
    manager.assignedAt = new Date();
    // Deliberately does NOT bump tokenVersion (PF-014).
    //
    // It used to, on the reasoning that site scope is baked into a token and a change
    // must not wait thirty days to take effect. That reasoning does not hold: the auth
    // middleware reloads `site_ids` and `site_name` from this document on EVERY
    // request, and `siteAccess` reads them from there — a token has never carried site
    // scope, so there was no stale-scope window to close. What the bump did instead was
    // sign the manager out of the app mid-task, on an action an owner performs
    // routinely, with a message telling them their session had expired.
    await manager.save();

    audit.record(req, {
      action: 'user.assign_site',
      entity: 'user',
      entity_id: manager._id,
      entity_label: manager.name,
      site_id: firstSite._id,
      site_name: firstSite.name,
      before,
      after: { site_ids: nextIds, site_name: manager.site_name },
    });

    const names = resolved.map(s => s.name).join(', ');
    return res.json({ success: true, message: `${manager.name} assigned to ${names}` });
  } catch (err) {
    console.error('[ASSIGN-SITE ERROR]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/users/managers-by-site/:siteName ────────────────────────────────
router.get('/managers-by-site/:siteName', auth, ownerOnly, async (req, res) => {
  try {
    const site = await resolveSite(req.params.siteName, req.user.orgId);
    if (!site) return res.json({ success: true, message: 'OK', data: [] });

    const managers = await User.find(live({
      role: 'manager',
      status: 'approved',
      orgId: req.user.orgId,
      $or: [{ site_ids: site._id }, { site_name: site.name }],
    })).sort({ name: 1 }).lean();

    const data = managers.map(m => ({
      id: m._id,
      name: m.name,
      phone: m.phone || '',
      site_name: site.name,
    }));
    return res.json({ success: true, message: 'OK', data });
  } catch (err) {
    console.error('[MANAGERS-BY-SITE ERROR]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/users/remove-from-site/:userId ─────────────────────────────────
// Owner only. Removes one site when `siteName` is given, otherwise all of them.
router.put('/remove-from-site/:userId', auth, ownerOnly, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isObjectId(userId)) return res.status(400).json({ success: false, message: 'Invalid manager id' });

    const manager = await User.findOne({ _id: userId, role: 'manager', orgId: req.user.orgId, deletedAt: null });
    if (!manager) return res.status(404).json({ success: false, message: 'Manager not found' });

    const before = { site_ids: (manager.site_ids || []).map(String), site_name: manager.site_name };

    let removedLabel = 'their site';
    if (isNonEmptyString(req.body?.siteName, 200)) {
      const site = await resolveSite(req.body.siteName, req.user.orgId);
      if (!site) return res.status(404).json({ success: false, message: 'Site not found' });
      manager.site_ids = (manager.site_ids || []).filter(id => String(id) !== String(site._id));
      removedLabel = site.name;
      if (manager.site_name === site.name) manager.site_name = '';
    } else {
      manager.site_ids = [];
      manager.site_name = '';
    }

    // Keep the display name pointing at a site they still hold, if any.
    if (!manager.site_name && manager.site_ids.length > 0) {
      const remaining = await Site.findById(manager.site_ids[0]).lean();
      manager.site_name = remaining?.name || '';
    }

    // As in assign-site above: no tokenVersion bump. Scope is re-read from this
    // document on every request, so removal takes effect on the manager's very next
    // call without ending their session (PF-014).
    await manager.save();

    audit.record(req, {
      action: 'user.remove_from_site',
      entity: 'user',
      entity_id: manager._id,
      entity_label: manager.name,
      before,
      after: { site_ids: manager.site_ids.map(String), site_name: manager.site_name },
    });

    return res.json({ success: true, message: `${manager.name} removed from ${removedLabel}` });
  } catch (err) {
    console.error('[REMOVE-FROM-SITE ERROR]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/managers/:userId/reset-password ─────────────────────────
// Owner or Super Admin sets a new password for one of their managers.
//
// A manager has no self-service route back in, and this is why: `forgot-password`
// only matches owners and super admins, and a manager signs in by PHONE, so an
// emailed code could not reach them even if it did. Most managers have no email
// address on file at all — they are invited by phone. The alternative, an SMS
// one-time code, needs a provider and (for Indian numbers) DLT registration with
// a telecom operator, which is weeks away and costs per message.
//
// So the person who already administers the manager resets it. That is not a
// privilege escalation: an owner can already see every site and every slip the
// manager can, and can remove them from a site entirely. It grants nothing new,
// it only makes an existing authority usable.
//
// The generated password is returned ONCE, in this response, for the admin to
// read out. It is never emailed, never logged, and cannot be retrieved again.
const TEMP_PASSWORD_LENGTH = 12;
// No 0/O, 1/l/I: this gets read down a phone line to someone on a building site.
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function generateTempPassword() {
  let out = '';
  // randomInt, not Math.random: this is a credential, and the difference is a
  // guessable stream versus an unguessable one.
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i += 1) {
    out += TEMP_PASSWORD_ALPHABET[crypto.randomInt(0, TEMP_PASSWORD_ALPHABET.length)];
  }
  return out;
}

router.post('/managers/:userId/reset-password', auth, ownerOnly, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isObjectId(userId)) return res.status(400).json({ success: false, message: 'Invalid manager id' });

    // Scoped to the caller's organisation, so one company's owner can never
    // reset another company's manager.
    const manager = await User.findOne({
      _id: userId, role: 'manager', orgId: req.user.orgId, deletedAt: null,
    });
    if (!manager) return res.status(404).json({ success: false, message: 'Manager not found' });

    // Generated passwords must satisfy the same policy as typed ones; if the
    // alphabet ever changes in a way that trips the rules, fail here rather than
    // hand out a password the manager's own next change would reject.
    let tempPassword = null;
    for (let attempt = 0; attempt < 5 && !tempPassword; attempt += 1) {
      const candidate = generateTempPassword();
      const check = validatePassword(candidate, {
        name: manager.name, email: manager.email, phone: manager.phone,
      });
      if (check.ok) tempPassword = candidate;
    }
    if (!tempPassword) {
      return res.status(500).json({ success: false, message: 'Could not generate a password. Try again.' });
    }

    await User.findByIdAndUpdate(manager._id, {
      password: await bcrypt.hash(tempPassword, 10),
      // Any half-finished reset code for this account dies with the password.
      otpHash: null,
      otpExpiry: null,
      otpAttempts: 0,
      // Unlike assign-site, this DOES end every existing session. A reset is what
      // you do when a phone is lost or a password may be known to someone else,
      // and leaving the old logins alive would defeat the point.
      $inc: { tokenVersion: 1 },
    });

    audit.record(req, {
      action: 'user.password_reset_by_admin',
      entity: 'user',
      entity_id: manager._id,
      entity_label: manager.name,
      note: 'Temporary password issued; all sessions ended',
    });

    return res.json({
      success: true,
      message: `Temporary password set for ${manager.name}. Read it to them now — it cannot be shown again.`,
      data: {
        name: manager.name,
        phone: manager.phone || '',
        tempPassword,
      },
    });
  } catch (err) {
    console.error('[MANAGER-RESET-PASSWORD ERROR]', err);
    captureError(err, { route: 'users.managerResetPassword' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/setup-super-admin ───────────────────────────────────────
router.post('/setup-super-admin', async (req, res) => {
  try {
    const { setupKey, name, email, password, orgName } = req.body;
    if (!process.env.SETUP_KEY) {
      return res.status(403).json({ success: false, message: 'Setup is disabled. Set SETUP_KEY in the environment to enable.' });
    }
    if (setupKey !== process.env.SETUP_KEY) {
      return res.status(403).json({ success: false, message: 'Invalid setup key' });
    }
    if (!isNonEmptyString(name) || !isNonEmptyString(email) || !isNonEmptyString(password, 128)) {
      return res.status(400).json({ success: false, message: 'Name, email and password required' });
    }
    const policy = validatePassword(password, { name, email });
    if (!policy.ok) return res.status(400).json({ success: false, message: policy.message });

    const existing = await User.findOne({ role: 'super_admin' });
    if (existing) return res.status(400).json({ success: false, message: 'Super admin already exists for this org' });

    const org = await Organization.create({ name: orgName || 'My Company' });
    const hashed = await bcrypt.hash(password, 10);
    const superAdmin = await User.create({
      name, email: email.toLowerCase(), password: hashed,
      role: 'super_admin', status: 'approved', orgId: org._id,
    });
    org.superAdminId = superAdmin._id;
    await org.save();
    return res.json({
      success: true,
      message: `Super Admin created for "${orgName}"`,
      token: makeToken(superAdmin),
      user: { id: superAdmin._id, name: superAdmin.name, email: superAdmin.email, role: superAdmin.role, orgId: org._id }
    });
  } catch (err) {
    if (respondIfDuplicate(res, err)) return;
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/register-company ────────────────────────────────────────
// Public — any company can self-register. Creates an Organisation + super_admin.
router.post('/register-company', async (req, res) => {
  try {
    const { name, email, password, companyName } = req.body;
    if (!isNonEmptyString(name) || !isNonEmptyString(email) || !isNonEmptyString(password, 128) || !isNonEmptyString(companyName)) {
      return res.status(400).json({ success: false, message: 'Company name, your name, email and password are all required' });
    }
    const policy = validatePassword(password, { name, email });
    if (!policy.ok) return res.status(400).json({ success: false, message: policy.message });

    // `deletedAt: null` matches the partial unique index in models/User.js. Without
    // it the two disagree: the index frees an address when the account is deleted,
    // and this check went on refusing it — so someone who deleted their account
    // could never come back, and was told the address was taken by an account that
    // no longer exists.
    const existing = await User.findOne({ email: email.toLowerCase(), deletedAt: null });
    if (existing) {
      return res.status(400).json({ success: false, message: 'An account with this email already exists' });
    }

    const org = await Organization.create({ name: companyName });

    // The organisation exists before the user does, so anything that fails from here
    // leaves it orphaned. That was harmless while User.create only failed on a bug;
    // with the PF-001 unique index it fails whenever two registrations race, which is
    // precisely the case this endpoint now has to survive. Losing the race must cost
    // the loser nothing, so the org is removed on any failure.
    let superAdmin;
    try {
      const hashed = await bcrypt.hash(password, 10);
      superAdmin = await User.create({
        name, email: email.toLowerCase(), password: hashed,
        role: 'super_admin', status: 'approved', orgId: org._id,
      });
    } catch (err) {
      await Organization.deleteOne({ _id: org._id }).catch(() => {});
      // The pre-check above catches the ordinary case; this catches the race it
      // cannot (PF-001), and answers it with the same message.
      if (respondIfDuplicate(res, err)) return;
      throw err;
    }

    org.superAdminId = superAdmin._id;
    await org.save();

    return res.json({
      ...userToResponse(superAdmin, makeToken(superAdmin)),
      message: `Welcome to BhoomiTrack! Your company "${companyName}" is ready.`,
      trial_ends_at: org.trialEndsAt,
    });
  } catch (err) {
    if (respondIfDuplicate(res, err)) return;
    console.error(err);
    captureError(err, { route: 'users.registerCompany' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Surfaced so the deployment runbook can confirm email is wired up without
// sending a real reset. Owner-only; reveals configuration state, not secrets.
router.get('/_mail-status', auth, ownerOnly, (req, res) => {
  res.json({ success: true, configured: mailConfigured() });
});

module.exports = router;
