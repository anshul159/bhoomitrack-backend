const mongoose = require('mongoose');

const slipItemSchema = new mongoose.Schema({
  material_name: String,
  quantity_taken: Number,
  unit: String,
  updated_stock: Number,
  inventory_id: mongoose.Schema.Types.ObjectId,
});

const slipSchema = new mongoose.Schema({
  site_name: { type: String, required: true },
  manager_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  manager_name: { type: String, default: '' },
  items: [slipItemSchema],
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
}, { timestamps: true });

module.exports = mongoose.model('Slip', slipSchema);
