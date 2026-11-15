// Every change to a service request goes through here (plan §6.2), whether the
// owner made it in the app or the desk made it in the Founder Dashboard, so the
// rules, the audit row and the push live in one place.
//
// Each change is a single conditional update: "move SR-000123 from options_ready
// to in_progress, if it is still in options_ready". Two people acting at once —
// the owner cancelling while the desk posts options — cannot both win.

const crypto = require('crypto');
const ServiceRequest = require('../models/ServiceRequest');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const push = require('./push');          // a module, not destructured: tests stand in for it
const { STATUS_LABELS, CANCELLABLE } = ServiceRequest;

class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Where the desk may move a request. The owner's own moves (choose, cancel) are
// separate functions with their own rules.
const DESK_TRANSITIONS = {
  interest: ['declined'],
  requested: ['in_review', 'options_ready', 'in_progress', 'done', 'declined'],
  in_review: ['options_ready', 'in_progress', 'done', 'declined'],
  options_ready: ['in_review', 'in_progress', 'done', 'declined'],
  in_progress: ['done', 'declined'],
};

const MAX_MESSAGE = 2000;
const cleanText = (v, max = MAX_MESSAGE) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ─── Who did it ───────────────────────────────────────────────────────────────
// An actor is either the owner, from a request (`{ req }`), or the desk
// (`{ desk: 'founder@…' }`). The desk is not a User of the customer's
// organisation, so its rows in the customer's audit trail carry no actor_id and
// say only "BhoomiTrack desk": which founder acted is recorded in the Founder
// Dashboard's own founder_audit, and is not the customer's to see.
const actorFields = (actor) => (actor.req
  ? { actor_id: actor.req.user.id, actor_name: actor.req.user.name || '', actor_role: actor.req.user.role || '' }
  : { actor_id: null, actor_name: 'BhoomiTrack desk', actor_role: 'bhoomitrack_desk' });
const byOf = (actor) => (actor.req ? 'customer' : 'desk');

async function auditChange(actor, request, action, before, after, note = '') {
  try {
    await AuditLog.create({
      orgId: request.orgId,
      ...actorFields(actor),
      action: `service_request.${action}`,
      entity: 'service_request',
      entity_id: request._id,
      entity_label: `${request.number} · ${request.title}`,
      site_id: request.site_id || null,
      site_name: request.site_name || '',
      before, after, note,
    });
  } catch (err) {
    console.error('[SERVICE REQUEST AUDIT]', action, err.message);
  }
}

/**
 * Tells the organisation's owners what changed. Only for the desk's changes: the
 * owner who chose an option does not need a notification saying so. Never for a
 * credit service's suggestion (there are none), and never awaited by a response.
 */
async function notifyOwners(request, title, body) {
  try {
    const owners = await User.find(
      { orgId: request.orgId, role: { $in: ['owner', 'super_admin'] }, deletedAt: null },
      'fcmTokens fcmToken'
    ).lean();
    if (owners.length === 0) return;
    await push.sendToUsers(owners, title, body, {
      type: 'service_request', requestId: String(request._id), number: request.number,
    });
  } catch (err) {
    console.error('[SERVICE REQUEST PUSH]', err.message);
  }
}

const pushAfter = (actor, request, title, body) => {
  if (byOf(actor) === 'desk') notifyOwners(request, title, body);
};

/**
 * The one write every change uses: move from one of `from` to `to`, appending to
 * the timeline, if the request is still where the caller saw it.
 */
async function move(filter, from, to, { actor, note = '', set = {}, pushTo = {} }) {
  const entry = { at: new Date(), status: to, note, by: byOf(actor) };
  const updated = await ServiceRequest.findOneAndUpdate(
    { ...filter, status: { $in: from } },
    { $set: { status: to, ...set }, $push: { timeline: entry, ...pushTo } },
    { new: true }
  );
  if (!updated) {
    const current = await ServiceRequest.findOne(filter, 'status').lean();
    if (!current) throw new RequestError('Request not found', 404);
    throw new RequestError(`This request is ${STATUS_LABELS[current.status].toLowerCase()} and cannot be changed that way`, 409);
  }
  return updated;
}

// ─── The owner's moves ────────────────────────────────────────────────────────

async function chooseOption(req, id, optionId) {
  const filter = { _id: id, orgId: req.user.orgId };
  const existing = await ServiceRequest.findOne(filter).lean();
  if (!existing) throw new RequestError('Request not found', 404);
  const option = (existing.options || []).find((o) => o.id === optionId);
  if (!option) throw new RequestError('That option was not found', 404);

  const updated = await move(filter, ['options_ready'], 'in_progress', {
    actor: { req }, note: `You chose ${option.label}`, set: { chosen_option_id: option.id },
  });
  auditChange({ req }, updated, 'choose', { status: 'options_ready' }, { status: 'in_progress', option: option.label });
  return updated;
}

async function cancel(req, id, reason) {
  const filter = { _id: id, orgId: req.user.orgId };
  const note = cleanText(reason, 500) || 'Cancelled by you';
  const before = await ServiceRequest.findOne(filter, 'status').lean();
  const updated = await move(filter, CANCELLABLE, 'cancelled', { actor: { req }, note });
  auditChange({ req }, updated, 'cancel', { status: before?.status }, { status: 'cancelled' }, note);
  return updated;
}

async function addMessage(actor, filter, text) {
  const clean = cleanText(text);
  if (clean.length === 0) throw new RequestError('Write a message first');
  // The customer exports their requests, so a desk message never names the founder.
  const byName = actor.req ? actor.req.user.name || '' : 'BhoomiTrack';
  const message = { at: new Date(), from: byOf(actor), text: clean, by_name: byName };
  const closed = ['done', 'cancelled', 'declined'];
  const updated = await ServiceRequest.findOneAndUpdate(
    { ...filter, status: { $nin: closed } },
    { $push: { messages: message } },
    { new: true }
  );
  if (!updated) {
    const exists = await ServiceRequest.exists(filter);
    throw exists ? new RequestError('This request is closed. Start a new one if you need more help.', 409)
      : new RequestError('Request not found', 404);
  }
  auditChange(actor, updated, 'message', null, null, clean.slice(0, 200));
  pushAfter(actor, updated, `${updated.number} · Message from BhoomiTrack`, clean.slice(0, 180));
  return updated;
}

// ─── The desk's moves ─────────────────────────────────────────────────────────

/** Any move in DESK_TRANSITIONS, with a note the owner sees on the timeline. */
async function deskSetStatus(desk, id, to, note) {
  const from = Object.keys(DESK_TRANSITIONS).filter((s) => DESK_TRANSITIONS[s].includes(to));
  if (from.length === 0 || to === 'done') {
    throw new RequestError(to === 'done' ? 'Use Mark done, which records the fee and any saving' : `Cannot move a request to ${to}`);
  }
  const filter = { _id: id };
  const before = await ServiceRequest.findOne(filter).lean();
  if (!before) throw new RequestError('Request not found', 404);
  if (to === 'options_ready' && (before.options || []).length === 0) {
    throw new RequestError('Add at least one option first');
  }
  const clean = cleanText(note, 500);
  const updated = await move(filter, from, to, { actor: { desk }, note: clean });
  auditChange({ desk }, updated, 'status', { status: before.status }, { status: to }, clean);
  pushAfter({ desk }, updated, `${updated.number} · ${STATUS_LABELS[to]}`, clean || updated.title);
  return updated;
}

/** An option for the owner to choose between: a quote, a plan, a time for a call. */
async function deskAddOption(desk, id, { label, provider, amount_rupees, summary }) {
  const cleanLabel = cleanText(label, 120);
  if (!cleanLabel) throw new RequestError('An option needs a name');
  let amountPaise = null;
  if (amount_rupees !== undefined && amount_rupees !== null && amount_rupees !== '') {
    const n = Number(String(amount_rupees).replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 0) throw new RequestError('The amount must be in rupees');
    amountPaise = Math.round(n * 100);
  }
  const option = {
    id: crypto.randomBytes(4).toString('hex'),
    label: cleanLabel,
    provider: cleanText(provider, 120),
    amount_paise: amountPaise,
    summary: cleanText(summary, 500),
  };
  const updated = await ServiceRequest.findOneAndUpdate(
    { _id: id, status: { $in: ['requested', 'in_review', 'options_ready'] } },
    { $push: { options: option } },
    { new: true }
  );
  if (!updated) {
    const exists = await ServiceRequest.exists({ _id: id });
    throw exists ? new RequestError('Options can only be added before the owner has chosen', 409)
      : new RequestError('Request not found', 404);
  }
  auditChange({ desk }, updated, 'option', null, { option: option.label, amount_paise: amountPaise });
  return updated;
}

/**
 * Done, with what it cost the owner, what we earned and what it saved them. A
 * saving needs its basis in words ("400 bags at ₹362 against your last rate of
 * ₹385"), or it is refused (plan §9).
 */
async function deskMarkDone(desk, id, { fee_rupees, commission_rupees, saved_rupees, saved_basis, note }) {
  const paise = (v, label) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(String(v).replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 0) throw new RequestError(`${label} must be in rupees`);
    return Math.round(n * 100);
  };
  const fee = paise(fee_rupees, 'The fee');
  const commission = paise(commission_rupees, 'The commission');
  const saved = paise(saved_rupees, 'The saving');
  const basis = cleanText(saved_basis, 300);
  if (saved && basis.length < 10) {
    throw new RequestError('Say how the saving was worked out, e.g. "400 bags at ₹362 against your last rate of ₹385"');
  }

  const filter = { _id: id };
  const before = await ServiceRequest.findOne(filter, 'status').lean();
  if (!before) throw new RequestError('Request not found', 404);
  const clean = cleanText(note, 500) || 'Done';
  const updated = await move(filter, ['requested', 'in_review', 'options_ready', 'in_progress'], 'done', {
    actor: { desk },
    note: clean,
    set: {
      'outcome.fee_paise': fee,
      'outcome.commission_paise': commission,
      'outcome.saved_paise': saved || null,
      'outcome.saved_basis': saved ? basis : '',
    },
  });
  auditChange({ desk }, updated, 'done', { status: before.status },
    { status: 'done', fee_paise: fee, commission_paise: commission, saved_paise: saved }, clean);
  pushAfter({ desk }, updated, `${updated.number} · Done`, clean === 'Done' ? updated.title : clean);
  return updated;
}

// ─── What the owner sees ──────────────────────────────────────────────────────

/**
 * The request as the app shows it. The commission is ours and is not in it; the
 * fee and the saving are the owner's.
 */
function presentRequest(r) {
  return {
    id: r._id,
    number: r.number,
    service_id: r.service_id,
    door: r.door,
    title: r.title,
    status: r.status,
    status_label: STATUS_LABELS[r.status],
    needs_you: r.status === 'options_ready',
    cancellable: CANCELLABLE.includes(r.status),
    site_id: r.site_id || null,
    site_name: r.site_name || '',
    details: r.details || {},
    consent: r.consent ? { shares: r.consent.shares, shared_with: r.consent.shared_with, given_at: r.consent.given_at } : null,
    options: (r.options || []).map((o) => ({
      id: o.id, label: o.label, provider: o.provider || '', amount_paise: o.amount_paise ?? null, summary: o.summary || '',
    })),
    chosen_option_id: r.chosen_option_id || null,
    timeline: (r.timeline || []).map((t) => ({ at: t.at, status: t.status, label: STATUS_LABELS[t.status], note: t.note || '', by: t.by })),
    messages: (r.messages || []).map((m) => ({ at: m.at, from: m.from, text: m.text, by_name: m.from === 'desk' ? 'BhoomiTrack' : (m.by_name || '') })),
    outcome: {
      fee_paise: r.outcome?.fee_paise ?? null,
      saved_paise: r.outcome?.saved_paise ?? null,
      saved_basis: r.outcome?.saved_basis || '',
    },
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

/** The short form, for lists. */
function presentRequestRow(r) {
  const p = presentRequest(r);
  return {
    id: p.id, number: p.number, service_id: p.service_id, door: p.door, title: p.title,
    status: p.status, status_label: p.status_label, needs_you: p.needs_you,
    site_name: p.site_name, option_count: p.options.length, updated_at: p.updated_at, created_at: p.created_at,
  };
}

module.exports = {
  RequestError, DESK_TRANSITIONS,
  chooseOption, cancel, addMessage,
  deskSetStatus, deskAddOption, deskMarkDone,
  presentRequest, presentRequestRow, auditChange, notifyOwners,
};
