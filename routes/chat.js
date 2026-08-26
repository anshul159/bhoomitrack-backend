const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Chat = require('../models/Chat');
const User = require('../models/User');
const { parsePaging, pageMeta, stableSort } = require('../utils/pagination');
const { isNonEmptyString, isObjectId } = require('../utils/validate');

// ─── GET /api/chat/:userId ────────────────────────────────────────────────────
// History of the conversation between the caller and :userId.
router.get('/:userId', auth, async (req, res) => {
  try {
    const myId = req.user.id;
    const otherId = req.params.userId;
    if (!isObjectId(otherId)) return res.status(400).json({ success: false, message: 'Invalid user id' });

    // ENH-020 — `POST /send` verified the other party was in the caller's
    // organisation; this endpoint did not. No cross-organisation message could
    // ever be read, because the query below only matches threads the caller is
    // part of, but a caller could probe arbitrary ids and tell "no conversation"
    // apart from one of their own. Closing it keeps the two endpoints honest.
    const other = await User.exists({ _id: otherId, orgId: req.user.orgId, deletedAt: null });
    if (!other) return res.status(404).json({ success: false, message: 'User not found' });

    const paging = parsePaging(req.query, { defaultLimit: 500 });
    const filter = {
      $or: [
        { sender_id: myId, receiver_id: otherId },
        { sender_id: otherId, receiver_id: myId },
      ],
    };

    // Newest-first for the page window, then flipped back to chronological so the
    // app renders a conversation in reading order.
    const [messages, total] = await Promise.all([
      Chat.find(filter).sort(stableSort({ createdAt: -1 })).skip(paging.skip).limit(paging.limit).lean(),
      Chat.countDocuments(filter),
    ]);
    messages.reverse();

    const data = messages.map(m => ({
      id: m._id, sender_id: m.sender_id, sender_name: m.sender_name,
      receiver_id: m.receiver_id, message: m.message,
      created_at: m.createdAt, is_mine: m.sender_id.toString() === myId,
    }));
    return res.json({ success: true, message: 'OK', data, page: pageMeta({ ...paging, total }) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/chat/send ──────────────────────────────────────────────────────
router.post('/send', auth, async (req, res) => {
  try {
    const { receiver_id, message } = req.body;
    if (!isObjectId(receiver_id)) return res.status(400).json({ success: false, message: 'Invalid receiver' });
    if (!isNonEmptyString(message, 2000)) return res.status(400).json({ success: false, message: 'Message must be 1–2000 characters' });

    // Receiver must be a real, live user in the same org
    const receiver = await User.exists({ _id: receiver_id, orgId: req.user.orgId, deletedAt: null });
    if (!receiver) return res.status(404).json({ success: false, message: 'Receiver not found' });

    await Chat.create({ sender_id: req.user.id, sender_name: req.user.name, receiver_id, message: message.trim() });
    return res.json({ success: true, message: 'Message sent' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
