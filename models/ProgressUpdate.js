const mongoose = require('mongoose');

// How far the work at a site has got (v2): a percentage reported by the site
// engineer or an owner, every few days, with what was done and optionally a
// photo of it.
//
// This is the "small project" way of tracking progress, from the conversation
// with Manas (2026-11-10): where the work is not itemised in a bill of
// quantities, nothing can count progress for you, so the engineer's own
// estimate is the progress — "every 3 days or every week" — and the owner
// compares it with what has been paid out (see utils/siteProgress.js).
//
// A record, like a payment: no approval step. A wrong entry is voided by an
// owner with a reason, never deleted, so the history stays complete. A lower
// figure than last time is allowed — an estimate can be corrected downwards.
const progressUpdateSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  site_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true },
  site_name: { type: String, required: true },

  // Work complete for the whole site, 0-100, to one decimal place.
  percent: { type: Number, required: true, min: 0, max: 100 },
  // What was done since the last update, in the engineer's words.
  work_done: { type: String, default: '' },
  photo_attachment_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Attachment', default: null },
  // The day the work was assessed. Back-dating is allowed (updates are often
  // entered the evening after), so the latest update is the latest `as_of`,
  // not the latest entry.
  as_of: { type: Date, required: true },

  recorded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recorded_by_name: { type: String, default: '' },
  recorded_by_role: { type: String, default: '' },

  status: { type: String, enum: ['recorded', 'void'], default: 'recorded' },
  void_reason: { type: String, default: '' },
  voided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  voided_at: { type: Date, default: null },

  client_request_id: { type: String, default: null },
}, { timestamps: true });

// The list (newest first) and "the latest recorded update" for a site.
progressUpdateSchema.index({ orgId: 1, site_id: 1, as_of: -1, createdAt: -1 });
// Same shape as the slip and payment indexes (PF-003): a retried submission on a
// bad connection returns the original update instead of recording it twice.
progressUpdateSchema.index(
  { orgId: 1, client_request_id: 1 },
  { unique: true, name: 'progress_client_request_unique', partialFilterExpression: { client_request_id: { $type: 'string' } } }
);

module.exports = mongoose.model('ProgressUpdate', progressUpdateSchema);
