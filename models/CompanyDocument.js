const mongoose = require('mongoose');

// A paper in the company file (BhoomiTrack Services, plan §6.3): a licence, a
// registration, a policy, an ITR, or anything else the owner keeps. The files
// themselves are in private object storage (utils/storage.js); this row holds
// where they are and what they say.
//
// A row with `not_needed: true` and no files is the owner saying "this slot does
// not apply to us", which takes it out of the score.
const fileSchema = new mongoose.Schema({
  key: { type: String, required: true },          // the storage key, never shown to a client
  content_type: { type: String, required: true }, // from the bytes, not from the client's claim
  size: { type: Number, required: true },
}, { _id: false });

const companyDocumentSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  slot: { type: String, required: true },          // 'labour.licence', or 'other'
  title: { type: String, default: '' },
  number: { type: String, default: '' },
  issued_on: { type: Date, default: null },
  expires_on: { type: Date, default: null },
  site_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', default: null },
  vehicle_label: { type: String, default: '' },
  files: { type: [fileSchema], default: [] },
  note: { type: String, default: '' },
  // An upload to a single-paper slot replaces the one before; the old row is kept
  // as history until the owner deletes it.
  status: { type: String, enum: ['active', 'replaced'], default: 'active' },
  not_needed: { type: Boolean, default: false },
  uploaded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  uploaded_by_name: { type: String, default: '' },
  source: { type: String, enum: ['upload', 'service_request'], default: 'upload' },
  // Expiry reminders already sent, as '<expires_on day>:<days before>', so a
  // reminder goes once per expiry date even across restarts (utils/reminders.js).
  reminders_sent: { type: [String], default: [] },
}, { timestamps: true });

companyDocumentSchema.index({ orgId: 1, slot: 1, status: 1 });
// For the reminder job, across every organisation.
companyDocumentSchema.index({ expires_on: 1 }, { partialFilterExpression: { status: 'active' } });

module.exports = mongoose.model('CompanyDocument', companyDocumentSchema);
