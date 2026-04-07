const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const auth = require('../middleware/auth');
const User = require('../models/User');
const Invite = require('../models/Invite');
const Organization = require('../models/Organization');

const makeToken = (user) => jwt.sign(
  { id: user._id, role: user.role, name: user.name, orgId: user.orgId },
  process.env.JWT_SECRET || 'bhoomitrack_secret',
  { expiresIn: '30d' }
);

// ─── POST /api/invite/generate ────────────────────────────────────────────────
// Super Admin or Owner generates a code to share via WhatsApp/SMS
router.post('/generate', auth, async (req, res) => {
  try {
    const sender = await User.findById(req.user.id);
    if (!sender || !['super_admin', 'owner'].includes(sender.role)) {
      return res.status(403).json({ success: false, message: 'Only Super Admins or Owners can generate invite codes' });
    }

    // Generate a simple 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Delete any previous unused invites from this sender
    await Invite.deleteMany({ invitedBy: sender._id, used: false });

    // Save new invite (no email required)
    await Invite.create({
      email: '',          // email not required for code-based invites
      code,
      orgId: sender.orgId,
      invitedBy: sender._id,
    });

    const org = await Organization.findById(sender.orgId);

    return res.json({
      success: true,
      message: 'Invite code generated',
      code,
      orgName: org?.name || 'BhoomiTrack',
      expiresIn: '7 days',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/invite/verify ──────────────────────────────────────────────────
// Check if an invite code is valid before registration
router.post('/verify', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'Code is required' });

    const invite = await Invite.findOne({
      code,
      used: false,
      expiresAt: { $gt: new Date() },
    });

    if (!invite) return res.status(400).json({ success: false, message: 'Invalid or expired invite code' });

    const org = await Organization.findById(invite.orgId);
    return res.json({
      success: true,
      message: 'Valid invite code',
      orgName: org?.name || '',
      orgId: invite.orgId,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/invite/register ────────────────────────────────────────────────
// New owner registers using invite code
router.post('/register', async (req, res) => {
  try {
    const { code, name, email, password } = req.body;
    if (!code || !name || !password) {
      return res.status(400).json({ success: false, message: 'Code, name and password are required' });
    }

    const invite = await Invite.findOne({
      code,
      used: false,
      expiresAt: { $gt: new Date() },
    });
    if (!invite) return res.status(400).json({ success: false, message: 'Invalid or expired invite code' });

    // Check if email already exists (if provided)
    if (email) {
      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    // Create owner account
    const hashed = await bcrypt.hash(password, 10);
    const owner = await User.create({
      name,
      email: email ? email.toLowerCase() : '',
      password: hashed,
      role: 'owner',
      status: 'approved',
      orgId: invite.orgId,
    });

    // Mark invite as used
    invite.used = true;
    await invite.save();

    const token = makeToken(owner);
    return res.json({
      success: true,
      message: 'Account created successfully',
      token,
      user: {
        id: owner._id,
        name: owner.name,
        email: owner.email,
        role: owner.role,
        approved: true,
        orgId: owner.orgId,
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
