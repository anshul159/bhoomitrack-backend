const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, default: '' },
  password: { type: String, default: '' },
  role: { type: String, enum: ['owner', 'manager'], default: 'manager' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  site_name: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
