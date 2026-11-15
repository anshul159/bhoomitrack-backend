const mongoose = require('mongoose');

// A service request (BhoomiTrack Services, plan §6.2): one object for every
// service behind every door, from a cement quote to a labour licence. The owner
// sees the same status timeline whatever it is; the desk (Founder Dashboard)
// moves it along.
//
// 'interest' is not a request: it is the "Tell me when this is available" tap on
// a service that is not live yet, recorded as demand. Nothing is shared and
// nothing is done.
const STATUSES = ['interest', 'requested', 'in_review', 'options_ready', 'in_progress', 'done', 'cancelled', 'declined'];
const OPEN_STATUSES = ['requested', 'in_review', 'options_ready', 'in_progress'];
// The owner may cancel until the work has started (plan §6.2).
const CANCELLABLE = ['interest', 'requested', 'in_review', 'options_ready'];

const STATUS_LABELS = {
  interest: 'We will tell you when this is available',
  requested: 'Requested',
  in_review: 'We are on it',
  options_ready: 'Options ready',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
  declined: 'We could not do this',
};

const optionSchema = new mongoose.Schema({
  id: { type: String, required: true },
  label: { type: String, required: true },
  provider: { type: String, default: '' },
  amount_paise: { type: Number, default: null, min: 0 },
  summary: { type: String, default: '' },
  document_id: { type: mongoose.Schema.Types.ObjectId, ref: 'CompanyDocument', default: null },
}, { _id: false });

const timelineSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  status: { type: String, enum: STATUSES, required: true },
  note: { type: String, default: '' },
  by: { type: String, enum: ['customer', 'desk'], required: true },
}, { _id: false });

const messageSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  from: { type: String, enum: ['customer', 'desk'], required: true },
  text: { type: String, required: true },
  by_name: { type: String, default: '' },
}, { _id: false });

const serviceRequestSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  number: { type: String, required: true },
  service_id: { type: String, required: true },
  door: { type: String, required: true },
  // A snapshot: a service renamed in the catalogue later must not rename history.
  title: { type: String, required: true },

  status: { type: String, enum: STATUSES, required: true },

  site_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', default: null },
  site_name: { type: String, default: '' },
  // The answers to the catalogue's `needs`, validated by utils/serviceForm.js.
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  worker_ids: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  document_ids: { type: [mongoose.Schema.Types.ObjectId], default: [] },

  // Exactly what the owner was told would be shared, and that they said yes
  // (DPDP: consent is for a purpose, so the purpose is stored with it).
  consent: {
    type: new mongoose.Schema({
      shares: { type: [String], default: [] },
      shared_with: { type: String, default: '' },
      given_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      given_at: { type: Date, required: true },
    }, { _id: false }),
    default: null,
  },

  options: { type: [optionSchema], default: [] },
  chosen_option_id: { type: String, default: null },
  timeline: { type: [timelineSchema], default: [] },
  messages: { type: [messageSchema], default: [] },

  // Written by the desk when the request is done. A saving is only ever stored
  // with the basis it was worked out on (plan §9): the desk cannot type a bare number.
  outcome: {
    fee_paise: { type: Number, default: null, min: 0 },
    commission_paise: { type: Number, default: null, min: 0 },
    saved_paise: { type: Number, default: null, min: 0 },
    saved_basis: { type: String, default: '' },
    fills_document_id: { type: mongoose.Schema.Types.ObjectId, ref: 'CompanyDocument', default: null },
  },
  // "Was this done well?", asked once at the end (plan §10).
  rating: { type: String, enum: ['good', 'bad', null], default: null },

  requested_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  requested_by_name: { type: String, default: '' },
  client_request_id: { type: String, default: null },
}, { timestamps: true });

// The owner's list, by status.
serviceRequestSchema.index({ orgId: 1, status: 1, updatedAt: -1 });
// The desk's queue, across every organisation.
serviceRequestSchema.index({ status: 1, updatedAt: -1 });
serviceRequestSchema.index({ number: 1 }, { unique: true });
// A retried "Send request" on a bad connection returns the first request.
serviceRequestSchema.index(
  { orgId: 1, client_request_id: 1 },
  { unique: true, name: 'service_request_client_unique', partialFilterExpression: { client_request_id: { $type: 'string' } } }
);

// One "tell me when" per service per organisation, even when it is tapped twice at once.
serviceRequestSchema.index(
  { orgId: 1, service_id: 1 },
  { unique: true, name: 'service_interest_unique', partialFilterExpression: { status: 'interest' } }
);

module.exports = mongoose.model('ServiceRequest', serviceRequestSchema);
module.exports.STATUSES = STATUSES;
module.exports.OPEN_STATUSES = OPEN_STATUSES;
module.exports.CANCELLABLE = CANCELLABLE;
module.exports.STATUS_LABELS = STATUS_LABELS;
