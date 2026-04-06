const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
  sender_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sender_name: { type: String, default: '' },
  receiver_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message: { type: String, required: true },
}, { timestamps: true });

module.exports = mongoose.model('Chat', chatSchema);
