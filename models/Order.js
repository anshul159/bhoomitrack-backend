const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  material_name: { type: String, required: true },
  quantity: { type: Number, required: true },
  unit: { type: String, default: 'units' },
  site_name: { type: String, required: true },
  status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  requested_by: { type: String, default: '' },
  requested_by_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reason: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
