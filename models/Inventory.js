const mongoose = require('mongoose');

const inventorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  quantity: { type: Number, default: 0 },
  unit: { type: String, default: 'units' },

  // `site_id` is authoritative (ENH-007). `site_name` is denormalised for display
  // and for compatibility with app builds that still query by name; it is kept in
  // step by the site-rename endpoint.
  site_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', index: true },
  site_name: { type: String, required: true },

  category: { type: String, default: 'Building Items' },
  // Per-material, editable by the owner (ENH-022). 50 stays the default so
  // existing materials behave exactly as before.
  low_stock_threshold: { type: Number, default: 50 },
  // What one `unit` costs, in the organisation's currency (ENH-017). Null means
  // "not priced" — reports must omit such materials from money totals rather
  // than treating them as free.
  unit_cost: { type: Number, default: null },

  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
}, { timestamps: true });

inventorySchema.index({ site_name: 1, name: 1 });
inventorySchema.index({ orgId: 1, site_id: 1, name: 1 });

module.exports = mongoose.model('Inventory', inventorySchema);
