
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

router.post('/generate', auth, async (req, res) => {

  try {

    const sender = await User.findById(req.user.id);

    if (!sender) return res.status(403).json({ success: false, message: 'User not found' });

    let inviteRole;

    if (sender.role === 'super_admin') inviteRole = 'owner';

    else if (sender.role === 'owner') inviteRole = 'manager';

    else return res.status(403).json({ success: false, message: 'Only Super Admins and Owners can generate invite codes' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();

    await Invite.deleteMany({ invitedBy: sender._id, used: false, role: inviteRole });

    await Invite.create({ email: '', code, role: inviteRole, orgId: sender.orgId, invitedBy: sender._id });

    const org = await Organization.findById(sender.orgId);

    return res.json({ success: true, message: 'Invite code generated', code, role: inviteRole, orgName: org?.name || 'BhoomiTrack', expiresIn: '7 days' });

  } catch (err) {

    console.error(err);

    res.status(500).json({ success: false, message: 'Server error' });

  }

});

router.post('/verify', async (req, res) => {

  try {

    const { code } = req.body;

    if (!code) return res.status(400).json({ success: false, message: 'Code is required' });

    const invite = await Invite.findOne({ code, used: false, expiresAt: { $gt: new Date() } });

    if (!invite) return res.status(400).json({ success: false, message: 'Invalid or expired invite code' });

    const org = await Organization.findById(invite.orgId);

    return res.json({ success: true, message: 'Valid invite code', orgName: org?.name || '', orgId: invite.orgId, role: invite.role });

  } catch (err) {

    res.status(500).json({ success: false, message: 'Server error' });

  }

});

router.post('/register', async (req, res) => {

  try {

    const { code, name, email, password, phone } = req.body;

    if (!code || !name || !password) return res.status(400).json({ success: false, message: 'Code, name and password are required' });

    const invite = await Invite.findOne({ code, used: false, expiresAt: { $gt: new Date() } });

    if (!invite) return res.status(400).json({ success: false, message: 'Invalid or expired invite code' });

    if (email) {

      const existing = await User.findOne({ email: email.toLowerCase() });

      if (existing) return res.status(400).json({ success: false, message: 'Email already registered' });

    }

    if (phone && invite.role === 'manager') {

      const existingPhone = await User.findOne({ phone });

      if (existingPhone) return res.status(400).json({ success: false, message: 'Phone number already registered' });

    }

    const hashed = await bcrypt.hash(password, 10);

    // Managers start as 'pending' so owner must approve; owners start approved
    const initialStatus = invite.role === 'manager' ? 'pending' : 'approved';

    const user = await User.create({

      name, email: email ? email.toLowerCase() : '', phone: phone || '',

      password: hashed, role: invite.role, status: initialStatus, orgId: invite.orgId,

    });

    invite.used = true;

    await invite.save();

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

    res.status(500).json({ success: false, message: err.message || 'Server error' });

  }

});

module.exports = router;

