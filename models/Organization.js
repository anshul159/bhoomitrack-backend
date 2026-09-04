const mongoose = require('mongoose');

// Subscription lifecycle (ENH-003).
//
// `status` is the single field the API gates on — see middleware/requireActiveOrg.js.
// A brand-new organisation starts on a trial; nothing charges yet, because no payment
// provider is wired up. The provider-specific fields below are deliberately left null
// and are the only part of billing that still needs an external account.
const ORG_STATUSES = ['trialing', 'active', 'past_due', 'suspended', 'cancelled'];

// Tiers are named after the customer, not the product: a contractor knows which
// one he is. 'standard' is the pre-tier value and is kept so existing rows and
// fixtures stay valid — nothing new should be created on it.
const ORG_PLANS = ['trial', 'site', 'contractor', 'builder', 'founding', 'standard'];

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 30);

const organizationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  superAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // ─── Subscription (ENH-003) ────────────────────────────────────────────────
  plan: { type: String, enum: ORG_PLANS, default: 'trial' },
  status: { type: String, enum: ORG_STATUSES, default: 'trialing', index: true },
  trialEndsAt: { type: Date, default: () => new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000) },
  currentPeriodEnd: { type: Date, default: null },
  // Set by an operator (or, later, a payment webhook) when access is cut off.
  suspendedAt: { type: Date, default: null },
  suspensionReason: { type: String, default: '' },

  // Populated once a payment provider is integrated. Null everywhere today.
  billingProvider: { type: String, default: null },     // e.g. 'razorpay'
  billingCustomerId: { type: String, default: null },
  billingSubscriptionId: { type: String, default: null },

  currency: { type: String, default: 'INR' },           // ENH-017 — money is org-wide

  // ─── Billing terms ─────────────────────────────────────────────────────────
  //
  // A negotiated price is not a pricing system, it is a fact about one customer,
  // so it lives on the customer. List prices are in utils/pricing.js; anything
  // set here overrides them for this organisation alone.
  //
  // Both override shapes exist because a real negotiation lands on either a unit
  // rate ("₹999 a site") or a round total ("₹40,000 for the year"), and forcing
  // the second into the first invents rates like ₹1,428.57.
  billing: {
    cycle: { type: String, enum: ['monthly', 'annual', 'lifetime'], default: 'monthly' },

    // Integer paise, both. Never floats: an invoice is a document handed to an
    // accountant, not an estimate someone typed.
    pricePerSitePaise: { type: Number, default: null, min: 0 },
    flatAmountPaise: { type: Number, default: null, min: 0 },

    // The buyer's GSTIN, captured so a tax invoice can name it — a contractor who
    // cannot claim input credit cannot put your software through his books.
    // Inert until there is a GST registration to invoice from.
    gstin: { type: String, default: null, trim: true, uppercase: true },

    agreedAt: { type: Date, default: null },
    agreedBy: { type: String, default: '' },
    note: { type: String, default: '' },
  },

  // What was actually collected, one row per period. This is the difference
  // between knowing a subscription is active and knowing why — without it,
  // extending currentPeriodEnd loses all record of the money behind it.
  payments: [{
    amountPaise: { type: Number, required: true, min: 0 },
    paidAt: { type: Date, default: Date.now },
    method: { type: String, default: '' },        // 'upi' | 'bank' | 'cash' | 'razorpay' | ...
    reference: { type: String, default: '' },     // UTR, cheque number, gateway payment id
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },     // null on a lifetime payment
    plan: { type: String, default: '' },
    siteCount: { type: Number, default: null },   // sites at the moment of billing
    recordedBy: { type: String, default: '' },
    note: { type: String, default: '' },
  }],
}, { timestamps: true });

// True when the org may use the API. Trials count as usable until they lapse.
organizationSchema.methods.isActive = function isActive(now = new Date()) {
  if (this.status === 'active') {
    return !this.currentPeriodEnd || this.currentPeriodEnd > now;
  }
  if (this.status === 'trialing') {
    return !this.trialEndsAt || this.trialEndsAt > now;
  }
  return false; // past_due, suspended, cancelled
};

// Why the org can't be used, in words the app can show the user.
organizationSchema.methods.inactiveReason = function inactiveReason(now = new Date()) {
  if (this.isActive(now)) return null;
  switch (this.status) {
    case 'trialing': return 'Your free trial has ended. Please subscribe to continue.';
    case 'active':   return 'Your subscription has lapsed. Please renew to continue.';
    case 'past_due': return 'A payment is overdue. Please update your billing to continue.';
    case 'suspended': return this.suspensionReason || 'This account has been suspended.';
    case 'cancelled': return 'This subscription has been cancelled.';
    default: return 'This account is not active.';
  }
};

// Total collected, for an operator's list. Paise.
organizationSchema.methods.totalPaidPaise = function totalPaidPaise() {
  return (this.payments || []).reduce((sum, p) => sum + (p.amountPaise || 0), 0);
};

module.exports = mongoose.model('Organization', organizationSchema);
module.exports.ORG_STATUSES = ORG_STATUSES;
module.exports.ORG_PLANS = ORG_PLANS;
