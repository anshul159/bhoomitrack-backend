const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  material_name: { type: String, required: true },
  quantity: { type: Number, required: true },
  unit: { type: String, default: 'units' },
  site_name: { type: String, required: true },
  status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  requested_by: { type: String, default: '' },
  reason: { type: String, default: '' },
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
}, { timestamps: true });

orderSchema.index({ site_name: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
