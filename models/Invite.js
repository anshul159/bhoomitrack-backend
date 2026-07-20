const mongoose = require('mongoose');

const inviteSchema = new mongoose.Schema({
  code: { type: String, required: true },
  role: { type: String, enum: ['owner', 'manager'], default: 'owner' },
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
}, { timestamps: true });

module.exports = mongoose.model('Invite', inviteSchema);
