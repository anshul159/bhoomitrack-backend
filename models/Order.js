const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  material_name: { type: String, required: true },
  quantity: { type: Number, required: true },
  unit: { type: String, default: 'units' },

  site_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', index: true },
  site_name: { type: String, required: true },

  status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  requested_by: { type: String, default: '' },
  requested_by_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reason: { type: String, default: '' },

  // ENH-017 — an owner deciding on a request wants to see what it will cost.
  unit_cost: { type: Number, default: null },
  estimated_total: { type: Number, default: null },

  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_at: { type: Date, default: null },
  decision_note: { type: String, default: '' },

  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
}, { timestamps: true });

orderSchema.index({ site_name: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ orgId: 1, site_id: 1, createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
