const mongoose = require('mongoose');

// One row per signed-in device (ENH-014). Replaces the former single `fcmToken`
// string, where the most recent device to log in silently stole push from every
// other device the person used.
const deviceTokenSchema = new mongoose.Schema({
  token: { type: String, required: true },
  platform: { type: String, default: 'android' },
  lastSeenAt: { type: Date, default: Date.now },
}, { _id: false });

// One row of the Create Site form's material list (ENH-097). `preselected` ticks
// the box before the owner touches anything; `unit` pre-fills the unit next to it.
const materialDefaultSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  unit: { type: String, default: 'units', trim: true },
  preselected: { type: Boolean, default: false },
}, { _id: false });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, default: '' },
  password: { type: String, default: '' },
  role: { type: String, enum: ['super_admin', 'owner', 'manager'], default: 'manager' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },

  // ─── Site assignment ───────────────────────────────────────────────────────
  // `site_ids` is authoritative (ENH-007 + ENH-016 — a manager may hold several
  // sites). `site_name` is kept in step with the FIRST assigned site purely so
  // existing app builds, which read a single site name, keep working.
  site_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Site', index: true }],
  site_name: { type: String, default: '' },
  assignedAt: { type: Date, default: null }, // when assignments were last changed

  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },

  // ─── Web console entitlement ───────────────────────────────────────────────
  //
  // Whether this person may sign in to app.bhoomitrack.com. Granted by the org's
  // super admin, who holds it implicitly and does not need the flag set.
  //
  // This is PERMISSION, not payment. Whether the company has paid is a fact about
  // the Organization (`status` / `currentPeriodEnd`) and is checked separately by
  // requireActiveOrg — deliberately not copied onto user rows, because managers
  // would then need a copy too and one subscription would become N that drift.
  //
  // It is also an ENTITLEMENT, NOT A SECURITY BOUNDARY: `ownerOnly` is
  // requireRole('owner','super_admin') on 28 routes and treats the two alike, so
  // an owner without this still holds full owner rights over the same data
  // through the Android app. Making it a boundary means splitting ownerOnly.
  webAppAccess: { type: Boolean, default: false },

  // Password-reset OTP. Stored as a bcrypt hash — a database or log dump must not
  // hand someone a working reset code (ENH-001).
  otpHash: { type: String, default: null },
  otpExpiry: { type: Date, default: null },
  otpAttempts: { type: Number, default: 0 },

  // ─── Profile picture ───────────────────────────────────────────────────────
  // A `data:image/...;base64,` URI rather than a URL, because there is no object
  // store in this deployment and adding one would mean a new provider account,
  // new credentials and a bill. The client downscales to 256x256 JPEG before
  // sending — 15-35 KB typically — so this stays far inside both Express's 1 MB
  // body limit and Mongo's 16 MB document limit. `select: false` keeps it OUT of
  // every query that does not ask for it: it must never ride along in a manager
  // list or a chat payload, which are already the largest responses (PF-005).
  avatar: { type: String, default: '', select: false },

  // ─── Create-site material defaults (ENH-097) ───────────────────────────────
  //
  // Which materials the Create Site form offers, and the unit each starts in. See
  // utils/materialDefaults.js for why this lives on the user.
  //
  // `default: undefined` is load-bearing. Mongoose otherwise gives every user an
  // empty array, which makes "has never opened the settings screen" — who must be
  // shown the built-in twelve — indistinguishable from "opened it and removed
  // every row", who must be shown nothing. Absent means seed, `[]` means empty.
  materialDefaults: { type: [materialDefaultSchema], default: undefined },

  // ─── Push (ENH-014) ────────────────────────────────────────────────────────
  fcmTokens: { type: [deviceTokenSchema], default: [] },

  // ─── Owner notifications (v2) ──────────────────────────────────────────────
  // Both off until the owner turns them on. One more push a day is something to
  // choose, not something to be given: PowerPlay's most specific one-star review
  // is "each notification repeats 4-5 times. it's like a spammer app".
  notificationPrefs: {
    dailySummary: { type: Boolean, default: false },
    // The hour, India time, after which the day's summary goes out.
    dailySummaryHour: { type: Number, default: 20, min: 0, max: 23 },
    largePaymentAlert: { type: Boolean, default: false },
    // In rupees, like every amount in the product. Alerts at or above it.
    largePaymentThreshold: { type: Number, default: 10000 },
  },
  // The India-time day (YYYY-MM-DD) the last daily summary was sent for. The
  // scheduler claims a day by setting this atomically before sending, so a
  // restart, or a second instance on the same tick, can never send it twice.
  dailySummarySentFor: { type: String, default: null },

  // ─── Session revocation (ENH-012) ──────────────────────────────────────────
  // Baked into every JWT as `tv`. auth middleware rejects a token whose `tv` is
  // behind this value, so logout, a role change or a site removal invalidates
  // outstanding tokens immediately despite their 30-day lifetime.
  tokenVersion: { type: Number, default: 0 },

  // ─── Account deletion (ENH-013) ────────────────────────────────────────────
  deletedAt: { type: Date, default: null },
  purgeAfter: { type: Date, default: null },
}, { timestamps: true });

userSchema.index({ phone: 1 });
userSchema.index({ email: 1 });
userSchema.index({ role: 1, status: 1, site_name: 1 });
userSchema.index({ orgId: 1, role: 1, status: 1 });
userSchema.index({ deletedAt: 1 });
// The scheduler's question every few minutes: who has asked for a daily summary.
// Partial, so the index holds only the owners who opted in.
userSchema.index(
  { 'notificationPrefs.dailySummary': 1, 'notificationPrefs.dailySummaryHour': 1 },
  { name: 'daily_summary_optin', partialFilterExpression: { 'notificationPrefs.dailySummary': true } }
);

// ─── Identity uniqueness (PF-001) ───────────────────────────────────────────────
//
// 20 simultaneous register-company calls on one email produced 20 accounts, in 15 of
// 15 rounds. The route looked the address up before inserting, which is a check and
// an insert with a gap between them — the classic read-then-write race. Only the
// database can close it.
//
// The consequence was worse than duplicate rows: `login` resolves with
// findOne({ email }), so the customer authenticated into a *different organisation*
// depending on which document the index happened to return. Their data appeared to
// vanish and come back between logins, with no way to recover inside the product.
//
// These are PARTIAL indexes for two reasons. Managers sign up with a phone and no
// email, owners with an email and no phone, and both default to '' — a plain unique
// index would let exactly one user in the entire system have a blank email. And a
// soft-deleted account should not hold its address hostage forever, so deleted rows
// are excluded and the address becomes reusable once the account is gone.
userSchema.index(
  { email: 1 },
  {
    unique: true,
    name: 'email_unique_active',
    partialFilterExpression: { email: { $gt: '' }, deletedAt: null },
  }
);

userSchema.index(
  { phone: 1 },
  {
    unique: true,
    name: 'phone_unique_active',
    partialFilterExpression: { phone: { $gt: '' }, deletedAt: null },
  }
);

module.exports = mongoose.model('User', userSchema);
