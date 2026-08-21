const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, default: '' },
  password: { type: String, default: '' },
  role: { type: String, enum: ['super_admin', 'owner', 'manager'], default: 'manager' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  site_name: { type: String, default: '' },
  assignedAt: { type: Date, default: null }, // when site_name was last set for a manager
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
  otp: { type: String, default: null },
  otpExpiry: { type: Date, default: null },
  fcmToken: { type: String, default: '' }, // current device's push token, for owner/manager notifications
}, { timestamps: true });

// Sparse-style lookups used by login / approval flows
userSchema.index({ phone: 1 });
userSchema.index({ email: 1 });
userSchema.index({ role: 1, status: 1, site_name: 1 });

module.exports = mongoose.model('User', userSchema);
