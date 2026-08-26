const mongoose = require('mongoose');

const slipItemSchema = new mongoose.Schema({
  material_name: String,
  quantity_taken: Number,
  unit: String,
  updated_stock: Number,
  inventory_id: mongoose.Schema.Types.ObjectId,
  // Cost captured at slip time (ENH-017). Held on the slip rather than read back
  // from Inventory so a later price change cannot rewrite history.
  unit_cost: { type: Number, default: null },
  line_total: { type: Number, default: null },
});

const slipSchema = new mongoose.Schema({
  site_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', index: true },
  site_name: { type: String, required: true },
  manager_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  manager_name: { type: String, default: '' },
  items: [slipItemSchema],
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  total_value: { type: Number, default: null },
  // Who decided, and when — the slip is the product's system of record (ENH-008).
  decided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decided_at: { type: Date, default: null },
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
}, { timestamps: true });

slipSchema.index({ site_name: 1, createdAt: -1 });
slipSchema.index({ status: 1, createdAt: -1 });
slipSchema.index({ orgId: 1, site_id: 1, createdAt: -1 });

module.exports = mongoose.model('Slip', slipSchema);
