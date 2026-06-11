const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
  sender_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sender_name: { type: String, default: '' },
  receiver_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message: { type: String, required: true },
}, { timestamps: true });

chatSchema.index({ sender_id: 1, receiver_id: 1, createdAt: 1 });
chatSchema.index({ receiver_id: 1, createdAt: 1 });

module.exports = mongoose.model('Chat', chatSchema);
