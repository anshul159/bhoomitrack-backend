const mongoose = require('mongoose');

// What an owner expects a site to cost (v2), to set against what has been paid
// out there and how far the work has got (utils/siteProgress.js). One per site.
//
// Owners set and revise it; a manager never sees it — the gap between a budget
// and a contract value is the owner's margin. A budget may be split by head
// using the payment categories (labour, material, equipment, ...), so each head
// can be compared with the payments of that kind. The split is optional and
// need not cover the whole amount: whatever is left is simply unallocated.
//
// A revision replaces the current figures and keeps the previous ones in
// `history`, so "budgeted ₹50 lakh, revised to ₹55 lakh in March" stays
// answerable — revising the estimate is normal; losing the first one is not.

const headSchema = new mongoose.Schema({
  category: { type: String, required: true },  // a SitePayment category
  amount: { type: Number, required: true },
}, { _id: false });

const revisionSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  heads: { type: [headSchema], default: [] },
  note: { type: String, default: '' },
  revision: { type: Number, required: true },
  set_by_name: { type: String, default: '' },
  set_at: { type: Date, required: true },
}, { _id: false });

const siteBudgetSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  site_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true },

  // Rupees, to two decimals — the same unit as SitePayment.amount, so the two
  // can be compared directly.
  amount: { type: Number, required: true },
  heads: { type: [headSchema], default: [] },
  note: { type: String, default: '' },
  // The first amount ever set, kept through every revision: "within 10% of the
  // budget" is a question about the original estimate as much as the current one.
  original_amount: { type: Number, required: true },

  // 1 when first set, +1 on every revision. A client that sends the revision it
  // was editing is refused if someone else revised the budget in between.
  revision: { type: Number, default: 1 },
  set_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  set_by_name: { type: String, default: '' },
  set_at: { type: Date, required: true },

  // Earlier versions, oldest first. Capped well above any real number of
  // revisions, so one site can never grow the document without bound.
  history: { type: [revisionSchema], default: [] },
}, { timestamps: true });

siteBudgetSchema.index({ orgId: 1, site_id: 1 }, { unique: true, name: 'org_site_budget_unique' });

module.exports = mongoose.model('SiteBudget', siteBudgetSchema);
module.exports.HISTORY_LIMIT = 50;
