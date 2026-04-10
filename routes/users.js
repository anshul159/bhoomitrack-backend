const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Organization = require('../models/Organization');
const auth = require('../middleware/auth');

const makeToken = (user) => jwt.sign(
  { id: user._id, role: user.role, name: user.name, orgId: user.orgId },
  process.env.JWT_SECRET || 'bhoomitrack_secret',
  { expiresIn: '30d' }
);

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
      if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });
      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) return res.status(400).json({ success: false, message: 'Email already registered' });
      const hashed = await bcrypt.hash(password, 10);
      const owner = await User.create({ name, email: email.toLowerCase(), password: hashed, role: 'owner', status: 'approved' });
      return res.json(userToResponse(owner, makeToken(owner)));
    }

    // Manager signup
    if (!name || !phone) return res.status(400).json({ success: false, message: 'Name and phone required' });
    const existing = await User.findOne({ phone });
    if (existing) return res.status(400).json({ success: false, message: 'Phone already registered' });
    const manager = await User.create({ name, phone, role: 'manager', status: 'pending', site_name: site || '' });
    return res.json(userToResponse(manager, makeToken(manager)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/login ────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });
    const user = await User.findOne({ email: email.toLowerCase(), role: { $in: ['owner', 'super_admin'] } });
    if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ success: false, message: 'Invalid credentials' });
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
    if (!phone) return res.status(400).json({ success: false, message: 'Phone required' });
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
    if (!phone || !otp) return res.status(400).json({ success: false, message: 'Phone and OTP required' });
    const user = await User.findOne({ phone, role: 'manager' });
    if (!user) return res.status(404).json({ success: false, message: 'Manager not found' });
    if (!user.otp || user.otp !== otp) return res.status(400).json({ success: false, message: 'Invalid OTP. Please check and try again.' });
    if (user.otpExpiry && new Date() > user.otpExpiry) return res.status(400).json({ success: false, message: 'OTP expired. Please request a new one.' });

    // Clear OTP after successful verification
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
    if (!email) return res.status(400).json({ success: false, message: 'Email required' });
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
    if (!email || !token || !newPassword) return res.status(400).json({ success: false, message: 'Email, token and new password required' });
    const user = await User.findOne({ email: email.toLowerCase(), role: { $in: ['owner', 'super_admin'] } });
    if (!user) return res.status(404).json({ success: false, message: 'Account not found' });
    if (!user.otp || user.otp !== token) return res.status(400).json({ success: false, message: 'Invalid reset token' });
    if (user.otpExpiry && new Date() > user.otpExpiry) return res.status(400).json({ success: false, message: 'Token expired. Please request a new reset.' });
    if (newPassword.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

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
// Owner: list all approved managers
router.get('/managers', auth, async (req, res) => {
  try {
    const managers = await User.find({ role: 'manager', status: 'approved' }).sort({ name: 1 });
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

// ─── GET /api/users/pending ───────────────────────────────────────────────────
router.get('/pending', auth, async (req, res) => {
  try {
    const managers = await User.find({ role: 'manager', status: 'pending' }).sort({ createdAt: -1 });
    const data = managers.map(m => ({
      id: m._id,
      name: m.name,
      phone: m.phone,
      site_name: m.site_name || 'Not assigned',
      created_at: m.createdAt,
    }));
    return res.json({ success: true, message: 'OK', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/users/check-phone/:phone ───────────────────────────────────────
router.get('/check-phone/:phone', async (req, res) => {
  try {
    const user = await User.findOne({ phone: req.params.phone, role: 'manager' });
    return res.json({
      success: true,
      exists: !!user,
      status: user?.status || null,
      site_name: user?.site_name || '',
      name: user?.name || '',
      user: user ? userToResponse(user, makeToken(user)).user : null
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/approve ──────────────────────────────────────────────────
router.post('/approve', auth, async (req, res) => {
  try {
    const { userId, approve, siteName } = req.body;
    const update = {
      status: approve ? 'approved' : 'rejected',
      ...(approve && siteName ? { site_name: siteName } : {}),
    };
    const user = await User.findByIdAndUpdate(userId, update, { new: true });
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
    if (setupKey !== (process.env.SETUP_KEY || 'bhoomitrack_setup_2024')) {
      return res.status(403).json({ success: false, message: 'Invalid setup key' });
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

module.exports = router;
