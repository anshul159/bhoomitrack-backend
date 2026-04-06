const mongoose = require('mongoose');

const inventorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  quantity: { type: Number, default: 0 },
  unit: { type: String, default: 'units' },
  site_name: { type: String, required: true },
  category: { type: String, default: 'Building Items' },
  low_stock_threshold: { type: Number, default: 50 },
}, { timestamps: true });

module.exports = mongoose.model('Inventory', inventorySchema);
