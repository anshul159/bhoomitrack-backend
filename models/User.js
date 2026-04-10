const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, default: '' },
  password: { type: String, default: '' },
  role: { type: String, enum: ['super_admin', 'owner', 'manager'], default: 'manager' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  site_name: { type: String, default: '' },
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
  otp: { type: String, default: null },
  otpExpiry: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
