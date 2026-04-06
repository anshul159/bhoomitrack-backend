const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Chat = require('../models/Chat');

// ─── GET /api/chat/:userId ────────────────────────────────────────────────────
router.get('/:userId', auth, async (req, res) => {
  try {
    const myId = req.user.id;
    const otherId = req.params.userId;
    const messages = await Chat.find({
      $or: [
        { sender_id: myId, receiver_id: otherId },
        { sender_id: otherId, receiver_id: myId },
      ]
    }).sort({ createdAt: 1 });

    const data = messages.map(m => ({
      id: m._id, sender_id: m.sender_id, sender_name: m.sender_name,
      receiver_id: m.receiver_id, message: m.message,
      created_at: m.createdAt, is_mine: m.sender_id.toString() === myId,
    }));
    return res.json({ success: true, message: 'OK', data });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /api/chat/send ──────────────────────────────────────────────────────
router.post('/send', auth, async (req, res) => {
  try {
    const { receiver_id, message } = req.body;
    await Chat.create({ sender_id: req.user.id, sender_name: req.user.name, receiver_id, message });
    return res.json({ success: true, message: 'Message sent' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
