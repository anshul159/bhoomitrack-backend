const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const auth = require('../middleware/auth');
const User = require('../models/User');
const Invite = require('../models/Invite');
const Organization = require('../models/Organization');
const { makeToken } = require('../utils/token');
const { isNonEmptyString } = require('../utils/validate');

// Generate a 6-digit code that doesn't collide with another active invite
async function generateUniqueCode() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const clash = await Invite.exists({ code, used: false, expiresAt: { $gt: new Date() } });
    if (!clash) return code;
  }
  throw new Error('Could not generate a unique invite code');
}

// ─── POST /api/invite/generate ────────────────────────────────────────────────
// super_admin → owner invite, owner → manager invite
router.post('/generate', auth, async (req, res) => {
  try {
    const sender = await User.findById(req.user.id);
    if (!sender) return res.status(403).json({ success: false, message: 'User not found' });

    let inviteRole;
    if (sender.role === 'super_admin') inviteRole = 'owner';
    else if (sender.role === 'owner') inviteRole = 'manager';
    else return res.status(403).json({ success: false, message: 'Only Super Admins and Owners can generate invite codes' });

    const code = await generateUniqueCode();

    // One active invite per sender per role — invalidate previous unused codes
    await Invite.deleteMany({ invitedBy: sender._id, used: false, role: inviteRole });
    await Invite.create({ email: '', code, role: inviteRole, orgId: sender.orgId, invitedBy: sender._id });

    const org = await Organization.findById(sender.orgId);
    return res.json({ success: true, message: 'Invite code generated', code, role: inviteRole, orgName: org?.name || 'BhoomiTrack', expiresIn: '7 days' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/invite/verify ──────────────────────────────────────────────────
router.post('/verify', async (req, res) => {
  try {
    const { code } = req.body;
    if (!isNonEmptyString(code, 10)) return res.status(400).json({ success: false, message: 'Code is required' });

    const invite = await Invite.findOne({ code, used: false, expiresAt: { $gt: new Date() } });
    if (!invite) return res.status(400).json({ success: false, message: 'Invalid or expired invite code' });

    const org = await Organization.findById(invite.orgId);
    return res.json({ success: true, message: 'Valid invite code', orgName: org?.name || '', orgId: invite.orgId, role: invite.role });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/invite/register ────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { code, name, email, password, phone } = req.body;
    if (!isNonEmptyString(code, 10) || !isNonEmptyString(name) || !isNonEmptyString(password, 100)) {
      return res.status(400).json({ success: false, message: 'Code, name and password are required' });
    }
    if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

    // Atomically consume the invite so the same code can't be redeemed twice concurrently
    const invite = await Invite.findOneAndUpdate(
      { code, used: false, expiresAt: { $gt: new Date() } },
      { used: true },
      { new: true }
    );
    if (!invite) return res.status(400).json({ success: false, message: 'Invalid or expired invite code' });

    // Helper to release the invite if registration fails validation below
    const releaseInvite = async () => { try { invite.used = false; await invite.save(); } catch (_) { /* noop */ } };

    if (email) {
      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) { await releaseInvite(); return res.status(400).json({ success: false, message: 'Email already registered' }); }
    }
    if (phone && invite.role === 'manager') {
      const existingPhone = await User.findOne({ phone });
      if (existingPhone) { await releaseInvite(); return res.status(400).json({ success: false, message: 'Phone number already registered' }); }
    }

    const hashed = await bcrypt.hash(password, 10);

    // Managers start as 'pending' so owner must approve; owners start approved
    const initialStatus = invite.role === 'manager' ? 'pending' : 'approved';

    const user = await User.create({
      name, email: email ? email.toLowerCase() : '', phone: phone || '',
      password: hashed, role: invite.role, status: initialStatus, orgId: invite.orgId,
    });

    const token = makeToken(user);
    console.log(`[REGISTER] ${invite.role} "${name}" registered via invite. Status: ${initialStatus}`);

    return res.json({
      success: true,
      message: invite.role === 'manager' ? 'Account created. Awaiting owner approval.' : 'Account created successfully.',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email || '',
        phone: user.phone || '',
        role: user.role,
        site_name: user.site_name || '',
        approved: user.status === 'approved',
        status: user.status,
      }
    });
  } catch (err) {
    console.error('[REGISTER ERROR]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
