const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const auth = require('../middleware/auth');
const User = require('../models/User');
const Invite = require('../models/Invite');
const Organization = require('../models/Organization');
const { makeToken } = require('../utils/token');
const { isNonEmptyString } = require('../utils/validate');
const { validatePassword } = require('../utils/password');

// Generate a 6-digit code that doesn't collide with another active invite
async function generateUniqueCode() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const clash = await Invite.exists({ code, expiresAt: { $gt: new Date() } });
    if (!clash) return code;
  }
  throw new Error('Could not generate a unique invite code');
}

// ─── POST /api/invite/generate ────────────────────────────────────────────────
// owner → manager invite only
// super_admin → owner invite by default, OR manager invite if body contains { role: 'manager' }
//
// Invite codes are reusable by design (an owner shares ONE code with as many
// managers as they're onboarding, valid for 7 days) — NOT single-use. By default
// this returns the sender's existing still-valid code instead of minting a new
// one, so re-opening the "Invite" screen doesn't silently invalidate a code
// that's already been shared. Pass { force: true } to explicitly invalidate and
// generate a fresh one (the "Generate New Code" button).
router.post('/generate', auth, async (req, res) => {
  try {
    const sender = await User.findById(req.user.id);
    if (!sender) return res.status(403).json({ success: false, message: 'User not found' });

    let inviteRole;
    if (sender.role === 'super_admin') {
      // A super_admin can mint either kind, so the role must be asked for explicitly.
      //
      // This used to default to `owner` when none was given (PF-012). The app never
      // sent one, so the button labelled "Invite Manager" handed out a code granting
      // full owner access — every site, all financials, and the power to invite more
      // owners — to someone the sender believed they were adding as a site manager.
      //
      // The app now always names the role. The default is `manager` so that a caller
      // that omits it — an older build, a direct API call — gets the *lesser*
      // privilege: asking for an owner invite and receiving a manager one is a visible,
      // harmless failure, while the reverse is a silent and dangerous one.
      inviteRole = req.body?.role === 'owner' ? 'owner' : 'manager';
    } else if (sender.role === 'owner') {
      inviteRole = 'manager';
    } else {
      return res.status(403).json({ success: false, message: 'Only Super Admins and Owners can generate invite codes' });
    }

    const force = req.body?.force === true;
    const org = await Organization.findById(sender.orgId);

    if (!force) {
      const existing = await Invite.findOne({ invitedBy: sender._id, role: inviteRole, expiresAt: { $gt: new Date() } })
        .sort({ createdAt: -1 });
      if (existing) {
        return res.json({ success: true, message: 'Invite code', code: existing.code, role: inviteRole, orgName: org?.name || 'BhoomiTrack', expiresIn: '7 days' });
      }
    }

    const code = await generateUniqueCode();

    // Explicit regenerate (or no active code exists) — clear out old codes for this role
    await Invite.deleteMany({ invitedBy: sender._id, role: inviteRole });
    await Invite.create({ code, role: inviteRole, orgId: sender.orgId, invitedBy: sender._id });

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

    const invite = await Invite.findOne({ code, expiresAt: { $gt: new Date() } });
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
    const policy = validatePassword(password, { name, email, phone });
    if (!policy.ok) return res.status(400).json({ success: false, message: policy.message });

    // Codes are reusable until expiry — not consumed on registration, so the same
    // code can onboard multiple managers (see /generate comment above).
    const invite = await Invite.findOne({ code, expiresAt: { $gt: new Date() } });
    if (!invite) return res.status(400).json({ success: false, message: 'Invalid or expired invite code' });

    if (email) {
      const existing = await User.findOne({ email: email.toLowerCase(), deletedAt: null });
      if (existing) return res.status(400).json({ success: false, message: 'Email already registered' });
    }
    if (phone && invite.role === 'manager') {
      const existingPhone = await User.findOne({ phone, deletedAt: null });
      if (existingPhone) return res.status(400).json({ success: false, message: 'Phone number already registered. Please log in instead.' });
    }

    const hashed = await bcrypt.hash(password, 10);

    // Knowing the invite code IS the approval — the owner already vetted who
    // they shared it with, so there's no separate manual-approve step anymore.
    // A manager lands approved but with no site yet; the owner assigns one
    // afterward via PUT /api/users/assign-site/:userId (see the "Unassigned
    // Managers" screen).
    const user = await User.create({
      name, email: email ? email.toLowerCase() : '', phone: phone || '',
      password: hashed, role: invite.role, status: 'approved', orgId: invite.orgId,
    });

    const token = makeToken(user);
    console.log(`[REGISTER] ${invite.role} "${name}" registered via invite and auto-approved.`);

    return res.json({
      success: true,
      message: invite.role === 'manager' ? 'Account created! You will be assigned to a site shortly.' : 'Account created successfully.',
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
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

module.exports = router;
