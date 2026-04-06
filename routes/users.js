const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const auth = require('../middleware/auth');

const makeToken = (user) => jwt.sign(
  { id: user._id, role: user.role, name: user.name },
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
// Used by manager registration and owner signup
router.post('/signup', async (req, res) => {
  try {
    const { name, phone, email, password, role, site } = req.body;

    if (role === 'owner') {
      // Owner signup
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
// Owner login with email + password
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });
    const user = await User.findOne({ email: email.toLowerCase(), role: 'owner' });
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
// Check if phone exists; return manager status
router.post('/otp/send', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone required' });
    const user = await User.findOne({ phone, role: 'manager' });
    // We return success always (no real OTP); the app uses this to check existence
    return res.json({ success: true, message: 'OK', exists: !!user, status: user?.status || null });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/users/otp/verify ──────────────────────────────────────────────
// Return manager data by phone (after OTP)
router.post('/otp/verify', async (req, res) => {
  try {
    const { phone } = req.body;
    const user = await User.findOne({ phone, role: 'manager' });
    if (!user) return res.status(404).json({ success: false, message: 'Manager not found' });
    return res.json(userToResponse(user, makeToken(user)));
  } catch (err) {
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

// ─── GET /api/users/check-phone/:phone ───────────────────────────────────────
// Check if manager phone exists and return their status
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

// ─── GET /api/users/pending ───────────────────────────────────────────────────
// Owner: list all pending managers
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

// ─── POST /api/users/approve ──────────────────────────────────────────────────
// Owner: approve or reject a manager, and optionally assign a site
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

module.exports = router;
