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

  // Idempotency key (PF-003).
  //
  // Five simultaneous identical generate calls created five slips, 15 rounds out of
  // 15. The server was not wrong — it was asked five times — but cold starts and
  // 60-second client timeouts are exactly what makes a person tap five times, and
  // approving those five slips deducts the stock five times.
  //
  // The client sends one id per composed slip and reuses it across every retry, so
  // a retry is recognisable as the same intent rather than a new one. Optional, so
  // that builds predating it keep working.
  client_request_id: { type: String, default: null },
}, { timestamps: true });

slipSchema.index({ site_name: 1, createdAt: -1 });
slipSchema.index({ status: 1, createdAt: -1 });
slipSchema.index({ orgId: 1, site_id: 1, createdAt: -1 });

// Partial so the many slips with no key — every slip from an older build — do not
// all collide on null. Scoped to the org for the same reason as the site index.
slipSchema.index(
  { orgId: 1, client_request_id: 1 },
  {
    unique: true,
    name: 'org_client_request_unique',
    partialFilterExpression: { client_request_id: { $type: 'string' } },
  }
);

module.exports = mongoose.model('Slip', slipSchema);
