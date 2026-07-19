const mongoose = require('mongoose');

const siteSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  location: { type: String, trim: true, default: '' },
  owner_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  materials: [{ type: String }],
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
}, { timestamps: true });

module.exports = mongoose.model('Site', siteSchema);
