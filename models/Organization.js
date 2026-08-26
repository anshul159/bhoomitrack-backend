const mongoose = require('mongoose');

// Subscription lifecycle (ENH-003).
//
// `status` is the single field the API gates on — see middleware/requireActiveOrg.js.
// A brand-new organisation starts on a trial; nothing charges yet, because no payment
// provider is wired up. The provider-specific fields below are deliberately left null
// and are the only part of billing that still needs an external account.
const ORG_STATUSES = ['trialing', 'active', 'past_due', 'suspended', 'cancelled'];
const ORG_PLANS = ['trial', 'standard'];

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

module.exports = mongoose.model('Organization', organizationSchema);
module.exports.ORG_STATUSES = ORG_STATUSES;
module.exports.ORG_PLANS = ORG_PLANS;
