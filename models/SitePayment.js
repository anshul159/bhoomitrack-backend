const mongoose = require('mongoose');

// Money paid out at a site (v2): labour, a delivered load of material, a small
// purchase, transport. A record of a payment already made, not a request — so
// there is no approval step. A wrong entry is voided by an owner with a reason,
// never deleted, so the history stays complete.
//
// Equipment (hire, fuel, repairs) and staff salary were added on 2026-11-11:
// with material and labour they are the four heads a contractor budgets a site
// by (the Manas conversation), and a budget head needs payments to compare with.
const CATEGORIES = ['labour', 'material', 'equipment', 'salary', 'purchase', 'transport', 'other'];
const PAYMENT_MODES = ['cash', 'upi', 'bank', 'cheque'];

const sitePaymentSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  site_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true },
  site_name: { type: String, required: true },

  category: { type: String, enum: CATEGORIES, required: true },
  // In the organisation's currency (rupees), to two decimals — the same unit as
  // Inventory.unit_cost, so reports can add the two together.
  amount: { type: Number, required: true },
  paid_to: { type: String, required: true, trim: true },
  payment_mode: { type: String, enum: [...PAYMENT_MODES, null], default: null },
  paid_on: { type: Date, required: true },
  note: { type: String, default: '' },

  // Delivery details, for a payment against material that came in a vehicle.
  vehicle_number: { type: String, default: '' },
  driver_name: { type: String, default: '' },
  // Optional — not every payment goes through a contractor.
  contractor_name: { type: String, default: '' },
  contractor_phone: { type: String, default: '' },

  bill_attachment_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Attachment', default: null },

  recorded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recorded_by_name: { type: String, default: '' },
  recorded_by_role: { type: String, default: '' },

  status: { type: String, enum: ['recorded', 'void'], default: 'recorded' },
  void_reason: { type: String, default: '' },
  voided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  voided_at: { type: Date, default: null },

  client_request_id: { type: String, default: null },
}, { timestamps: true });

sitePaymentSchema.index({ orgId: 1, site_id: 1, paid_on: -1 });
// Same shape as the slip index (PF-003): a retried submission on a bad
// connection returns the original record instead of paying twice on paper.
sitePaymentSchema.index(
  { orgId: 1, client_request_id: 1 },
  { unique: true, name: 'payment_client_request_unique', partialFilterExpression: { client_request_id: { $type: 'string' } } }
);

module.exports = mongoose.model('SitePayment', sitePaymentSchema);
module.exports.CATEGORIES = CATEGORIES;
module.exports.PAYMENT_MODES = PAYMENT_MODES;
// The words the app shows, for messages the server writes itself (alerts).
module.exports.CATEGORY_LABELS = {
  labour: 'Labour', material: 'Material', equipment: 'Equipment', salary: 'Staff salary',
  purchase: 'Petty purchase', transport: 'Transport', other: 'Other',
};
