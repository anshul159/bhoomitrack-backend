const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Organization = require('../models/Organization');
const auth = require('../middleware/auth');
const { ownerOnly } = require('../middleware/roles');
const { makeToken } = require('../utils/token');
const { isNonEmptyString } = require('../utils/validate');

const userToResponse = (user, token) => ({
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
    approved: user.status === 'approved',
    status: user.status,
  }
});

// ─── POST /api/users/signup ───────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { name, phone, email, password, role, site } = req.body;

    if (role === 'owner') {
      if (!isNonEmptyString(email) || !isNonEmptyString(password, 100)) {
        return res.status(400).json({ success: false, message: 'Email and password required' });
      }
      if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
      if (!isNonEmptyString(name)) return res.status(400).json({ success: false, message: 'Name required' });
      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) return res.status(400).json({ success: false, message: 'Email already registered' });
      const hashed = await bcrypt.hash(password, 10);
      const owner = await User.create({ name, email: email.toLowerCase(), password: hashed, role: 'owner', status: 'approved' });
      return res.json(userToResponse(owner, makeToken(owner)));
    }

    // Manager signup — account starts as 'pending'. No token is issued until the
    // manager is approved and logs in (issuing tokens to unapproved users was a security hole).
    if (!isNonEmptyString(name) || !isNonEmptyString(phone, 20)) {
      return res.status(400).json({ success: false, message: 'Name and phone required' });
    }
    const existing = await User.findOne({ phone });
    if (existing) return res.status(400).json({ success: false, message: 'Phone already registered' });
    const manager = await User.create({ name, phone, role: 'manager', status: 'pending', site_name: site || '' });
    return res.json(userToResponse(manager, null));
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/login ────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!isNonEmptyString(email) || !isNonEmptyString(password, 100)) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }
    const user = await User.findOne({ email: email.toLowerCase(), role: { $in: ['owner', 'super_admin'] } });
    if (!user || !user.password) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    return res.json(userToResponse(user, makeToken(user)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/manager-login ───────────────────────────────────────────
router.post('/manager-login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!isNonEmptyString(phone, 20) || !isNonEmptyString(password, 100)) {
      return res.status(400).json({ success: false, message: 'Phone and password required' });
    }
    const user = await User.findOne({ phone, role: 'manager' });
    if (!user) return res.status(401).json({ success: false, message: 'Invalid phone number or password' });
    if (!user.password) return res.status(401).json({ success: false, message: 'No password set. Please register via invite code.' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ success: false, message: 'Invalid phone number or password' });
    return res.json(userToResponse(user, makeToken(user)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/otp/send ─────────────────────────────────────────────────
// Generate real 6-digit OTP, store in user, log to console for testing
router.post('/otp/send', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!isNonEmptyString(phone, 20)) return res.status(400).json({ success: false, message: 'Phone required' });
    const user = await User.findOne({ phone, role: 'manager' });
    if (!user) return res.json({ success: true, message: 'OK', exists: false, status: null });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await User.findByIdAndUpdate(user._id, { otp, otpExpiry });

    // Log OTP to console (visible in Render logs)
    console.log(`[OTP LOGIN] Phone: ${phone} | OTP: ${otp} | Expires: ${otpExpiry.toISOString()}`);

    return res.json({ success: true, message: 'OTP sent', exists: true, status: user.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/otp/verify ──────────────────────────────────────────────
// Verify OTP and return manager data
router.post('/otp/verify', async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!isNonEmptyString(phone, 20) || !isNonEmptyString(otp, 10)) {
      return res.status(400).json({ success: false, message: 'Phone and OTP required' });
    }
    const user = await User.findOne({ phone, role: 'manager' });
    if (!user) return res.status(404).json({ success: false, message: 'Manager not found' });
    if (!user.otp || user.otp !== otp) return res.status(400).json({ success: false, message: 'Invalid OTP. Please check and try again.' });
    if (user.otpExpiry && new Date() > user.otpExpiry) return res.status(400).json({ success: false, message: 'OTP expired. Please request a new one.' });

    // Clear OTP after successful verification (single use)
    await User.findByIdAndUpdate(user._id, { otp: null, otpExpiry: null });
    return res.json(userToResponse(user, makeToken(user)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/forgot-password ─────────────────────────────────────────
// Request password reset token (logged to Render console)
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!isNonEmptyString(email)) return res.status(400).json({ success: false, message: 'Email required' });
    const user = await User.findOne({ email: email.toLowerCase(), role: { $in: ['owner', 'super_admin'] } });
    if (!user) return res.status(404).json({ success: false, message: 'No account found with this email' });

    const resetToken = Math.floor(100000 + Math.random() * 900000).toString();
    const tokenExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    await User.findByIdAndUpdate(user._id, { otp: resetToken, otpExpiry: tokenExpiry });

    // Log token to console (visible in Render logs — check render.com dashboard)
    console.log(`[PASSWORD RESET] Email: ${email} | Token: ${resetToken} | Expires: ${tokenExpiry.toISOString()}`);

    return res.json({ success: true, message: 'Reset token generated. Check Render logs for the token.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/reset-password ──────────────────────────────────────────
// Verify token and set new password
router.post('/reset-password', async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;
    if (!isNonEmptyString(email) || !isNonEmptyString(token, 10) || !isNonEmptyString(newPassword, 100)) {
      return res.status(400).json({ success: false, message: 'Email, token and new password required' });
    }
    if (newPassword.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    const user = await User.findOne({ email: email.toLowerCase(), role: { $in: ['owner', 'super_admin'] } });
    if (!user) return res.status(404).json({ success: false, message: 'Account not found' });
    if (!user.otp || user.otp !== token) return res.status(400).json({ success: false, message: 'Invalid reset token' });
    if (user.otpExpiry && new Date() > user.otpExpiry) return res.status(400).json({ success: false, message: 'Token expired. Please request a new reset.' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await User.findByIdAndUpdate(user._id, { password: hashed, otp: null, otpExpiry: null });
    return res.json({ success: true, message: 'Password reset successfully. You can now log in.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/users/profile ───────────────────────────────────────────────────
router.get('/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json(userToResponse(user, null));
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/users/owner ─────────────────────────────────────────────────────
// Manager: get the owner/super_admin for their org
router.get('/owner', auth, async (req, res) => {
  try {
    const caller = await User.findById(req.user.id);
    if (!caller) return res.status(403).json({ success: false, message: 'User not found' });
    // Find owner or super_admin in same org
    const owner = await User.findOne({
      role: { $in: ['owner', 'super_admin'] },
      orgId: caller.orgId
    });
    if (!owner) return res.status(404).json({ success: false, message: 'No owner found for your org' });
    return res.json({ success: true, data: { id: owner._id, name: owner.name, phone: owner.phone || '', site_name: '' } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/users/managers ──────────────────────────────────────────────────
// Owner only: list all approved managers in this org
router.get('/managers', auth, ownerOnly, async (req, res) => {
  try {
    const managers = await User.find({ role: 'manager', status: 'approved', orgId: req.user.orgId }).sort({ name: 1 }).lean();
    const data = managers.map(m => ({
      id: m._id,
      name: m.name,
      phone: m.phone || '',
      site_name: m.site_name || '',
    }));
    return res.json({ success: true, message: 'OK', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/users/managers-by-site/:siteName ────────────────────────────────
// Owner only: list all approved managers assigned to a specific site in this org
router.get('/managers-by-site/:siteName', auth, ownerOnly, async (req, res) => {
  try {
    const { siteName } = req.params;
    const managers = await User.find({
      role: 'manager',
      status: 'approved',
      site_name: siteName,
      orgId: req.user.orgId
    }).sort({ name: 1 }).lean();
    const data = managers.map(m => ({
      id: m._id,
      name: m.name,
      phone: m.phone || '',
      site_name: m.site_name || '',
    }));
    return res.json({ success: true, message: 'OK', data });
  } catch (err) {
    console.error('[MANAGERS-BY-SITE ERROR]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/users/remove-from-site/:userId ─────────────────────────────────
// Owner only: unassign a manager from their current site (sets site_name to '')
router.put('/remove-from-site/:userId', auth, ownerOnly, async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findOneAndUpdate(
      { _id: userId, role: 'manager', orgId: req.user.orgId },
      { site_name: '' },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, message: 'Manager not found' });
    console.log(`[REMOVE-FROM-SITE] ${user.name} (${user._id}) removed from site by owner ${req.user.id}`);
    return res.json({ success: true, message: `${user.name} removed from site` });
  } catch (err) {
    console.error('[REMOVE-FROM-SITE ERROR]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/users/pending ───────────────────────────────────────────────────
// Owner only: managers awaiting approval in this org
router.get('/pending', auth, ownerOnly, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    if (!orgId) {
      // Token is missing orgId even after the auth-middleware fallback — tell the client.
      console.warn(`[PENDING] orgId missing for user ${req.user.id} — client should re-login`);
      return res.status(400).json({ success: false, message: 'Session is outdated. Please log out and log back in.' });
    }
    const managers = await User.find({ role: 'manager', status: 'pending', orgId }).sort({ createdAt: -1 }).lean();
    console.log(`[PENDING] orgId=${orgId} → found ${managers.length} pending manager(s)`);
    const data = managers.map(m => ({
      id: m._id,
      name: m.name,
      phone: m.phone,
      site_name: m.site_name || 'Not assigned',
      created_at: m.createdAt,
    }));
    return res.json({ success: true, message: 'OK', data });
  } catch (err) {
    console.error('[PENDING ERROR]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/users/check-phone/:phone ───────────────────────────────────────
// Public endpoint used during registration/login pre-checks.
// SECURITY FIX: returns only existence + status now. It previously returned a
// full auth token for any phone number, which let anyone impersonate a manager.
router.get('/check-phone/:phone', async (req, res) => {
  try {
    const user = await User.findOne({ phone: req.params.phone, role: 'manager' }).lean();
    return res.json({
      success: true,
      exists: !!user,
      status: user?.status || null,
      site_name: user?.site_name || '',
      name: user?.name || '',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/approve ──────────────────────────────────────────────────
// Owner only: approve/reject a pending manager
router.post('/approve', auth, ownerOnly, async (req, res) => {
  try {
    const { userId, approve, siteName } = req.body;
    if (!isNonEmptyString(userId, 50)) return res.status(400).json({ success: false, message: 'userId required' });
    const update = {
      status: approve ? 'approved' : 'rejected',
      ...(approve && siteName ? { site_name: siteName } : {}),
      // Assign manager to this owner's org when approving
      ...(approve ? { orgId: req.user.orgId } : {}),
    };
    const user = await User.findOneAndUpdate({ _id: userId, role: 'manager' }, update, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, message: approve ? `${user.name} approved` : `${user.name} rejected` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/setup-super-admin ───────────────────────────────────────
router.post('/setup-super-admin', async (req, res) => {
  try {
    const { setupKey, name, email, password, orgName } = req.body;
    // SECURITY FIX: SETUP_KEY must be configured in the environment — no hardcoded default.
    if (!process.env.SETUP_KEY) {
      return res.status(403).json({ success: false, message: 'Setup is disabled. Set SETUP_KEY in the environment to enable.' });
    }
    if (setupKey !== process.env.SETUP_KEY) {
      return res.status(403).json({ success: false, message: 'Invalid setup key' });
    }
    if (!isNonEmptyString(name) || !isNonEmptyString(email) || !isNonEmptyString(password, 100)) {
      return res.status(400).json({ success: false, message: 'Name, email and password required' });
    }
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
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/register-company ────────────────────────────────────────
// Public — any company can self-register. Creates an Organisation + super_admin.
router.post('/register-company', async (req, res) => {
  try {
    const { name, email, password, companyName } = req.body;
    if (!name || !email || !password || !companyName) {
      return res.status(400).json({ success: false, message: 'Company name, your name, email and password are all required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, message: 'An account with this email already exists' });
    }
    const org = await Organization.create({ name: companyName });
    const hashed = await bcrypt.hash(password, 10);
    const superAdmin = await User.create({
      name, email: email.toLowerCase(), password: hashed,
      role: 'super_admin', status: 'approved', orgId: org._id,
    });
    org.superAdminId = superAdmin._id;
    await org.save();
    return res.json({
      ...userToResponse(superAdmin, makeToken(superAdmin)),
      message: `Welcome to BhoomiTrack! Your company "${companyName}" is ready.`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
