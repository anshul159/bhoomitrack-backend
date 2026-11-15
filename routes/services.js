const express = require('express');
const router = express.Router();
// No `auth` here on purpose — applied at the mount in server.js (PF-007).
const { ownerOnly } = require('../middleware/roles');
const Organization = require('../models/Organization');
const ServiceRequest = require('../models/ServiceRequest');
const Site = require('../models/Site');
const { getService, catalogueFor } = require('../config/serviceCatalogue');
const { validateDetails, FormError } = require('../utils/serviceForm');
const numbering = require('../utils/numbering');
const audit = require('../utils/audit');
const { isObjectId } = require('../utils/validate');
const { clientRequestId, createOnce, ValidationError } = require('../utils/siteRecords');
const sr = require('../utils/serviceRequests');
const { captureError } = require('../utils/observability');
const { loadCompanyFile, inPlaceSlots } = require('../utils/companyFile');
const { allSignals, topSignals } = require('../utils/serviceSignals');
const { indiaClock } = require('../utils/dailySummary');
const { presentProfile } = require('../utils/orgProfile');

// BhoomiTrack Services (plan §6.2): the owner's Services tab. Owner only, every
// route — the tab, the company file and every request are the business's own
// affairs, not the site's.
router.use(ownerOnly);

/** Sends a known error as itself and anything else as a 500. */
function fail(res, err, route) {
  if (err instanceof FormError) return res.status(400).json({ success: false, message: err.message, field: err.field });
  if (err instanceof sr.RequestError || err instanceof ValidationError) {
    return res.status(err.status || 400).json({ success: false, message: err.message });
  }
  console.error(`[SERVICES ${route}]`, err);
  captureError(err, { route: `services.${route}` });
  return res.status(500).json({ success: false, message: 'Server error' });
}

const orgProfile = async (orgId) => (await Organization.findById(orgId, 'profile').lean())?.profile || {};

/** 1 April of the current Indian financial year, as an instant (India midnight). */
function financialYearStart(now = new Date()) {
  const { day } = indiaClock(now);
  const y = Number(day.slice(0, 4));
  const startYear = Number(day.slice(5, 7)) >= 4 ? y : y - 1;
  return new Date(Date.UTC(startYear, 3, 1) - (5 * 60 + 30) * 60 * 1000);
}

// ─── GET /api/services/home ───────────────────────────────────────────────────
// Everything the Services tab shows, in one call (plan §5.3): the company file's
// summary, at most two suggestions, the open requests, the year's savings, and
// the tab's badge.
router.get('/home', async (req, res) => {
  try {
    const now = new Date();
    const orgId = req.user.orgId;
    const { org, file } = await loadCompanyFile(orgId, now);

    const signals = topSignals(
      allSignals(file, { profile: presentProfile(org?.profile), inPlace: inPlaceSlots(file) }, indiaClock(now).day),
      org?.services?.dismissed || [],
      now
    );

    const since = financialYearStart(now);
    const [open, saved] = await Promise.all([
      ServiceRequest.find({ orgId, status: { $in: ServiceRequest.OPEN_STATUSES } }).sort({ updatedAt: -1 }).limit(20).lean(),
      ServiceRequest.aggregate([
        { $match: { orgId: org?._id || null, status: 'done', 'outcome.saved_paise': { $gt: 0 }, updatedAt: { $gte: since } } },
        { $group: { _id: null, total: { $sum: '$outcome.saved_paise' }, count: { $sum: 1 } } },
      ]),
    ]);
    const waiting = open.filter((r) => r.status === 'options_ready').length;

    return res.json({
      success: true,
      data: {
        company_file: { score: file.score, counts: file.counts, questions: file.questions },
        signals,
        requests: open.map(sr.presentRequestRow),
        savings: { since: since.toISOString(), total_paise: saved[0]?.total || 0, count: saved[0]?.count || 0 },
        // Only what needs the owner (plan §5.2): a choice to make, a paper that has run out.
        badge: waiting + file.counts.expired,
      },
    });
  } catch (err) {
    return fail(res, err, 'home');
  }
});

// ─── GET /api/services/savings ────────────────────────────────────────────────
// The list behind "Saved with BhoomiTrack this year", each with how it was worked out.
router.get('/savings', async (req, res) => {
  try {
    const since = financialYearStart();
    const rows = await ServiceRequest.find({
      orgId: req.user.orgId, status: 'done', 'outcome.saved_paise': { $gt: 0 }, updatedAt: { $gte: since },
    }).sort({ updatedAt: -1 }).lean();
    return res.json({
      success: true,
      data: {
        since: since.toISOString(),
        total_paise: rows.reduce((n, r) => n + r.outcome.saved_paise, 0),
        items: rows.map((r) => ({
          id: r._id, number: r.number, title: r.title, site_name: r.site_name || '',
          saved_paise: r.outcome.saved_paise, saved_basis: r.outcome.saved_basis, done_at: r.updatedAt,
        })),
      },
    });
  } catch (err) {
    return fail(res, err, 'savings');
  }
});

// ─── POST /api/services/signals/:id/dismiss ───────────────────────────────────
// Hides one suggestion for 30 days (plan §5.1 rule 6).
const DISMISS_DAYS = 30;
router.post('/signals/:id/dismiss', async (req, res) => {
  try {
    const signalId = String(req.params.id || '');
    if (!/^[a-z_]+:[A-Za-z0-9_.:-]{0,120}$/.test(signalId)) {
      return res.status(400).json({ success: false, message: 'Invalid suggestion' });
    }
    const now = new Date();
    const until = new Date(now.getTime() + DISMISS_DAYS * 24 * 60 * 60 * 1000);
    // Drop this one and anything already lapsed, then add it back with a fresh date.
    await Organization.updateOne({ _id: req.user.orgId }, {
      $pull: { 'services.dismissed': { $or: [{ signal_id: signalId }, { until: { $lte: now } }] } },
    });
    await Organization.updateOne({ _id: req.user.orgId }, {
      $push: { 'services.dismissed': { signal_id: signalId, until } },
    });
    return res.json({ success: true, message: 'Hidden for 30 days', data: { signal_id: signalId, until } });
  } catch (err) {
    return fail(res, err, 'dismiss');
  }
});

// ─── GET /api/services/catalogue ──────────────────────────────────────────────
router.get('/catalogue', async (req, res) => {
  try {
    return res.json({ success: true, data: catalogueFor(await orgProfile(req.user.orgId)) });
  } catch (err) {
    return fail(res, err, 'catalogue');
  }
});

// ─── POST /api/services/requests ──────────────────────────────────────────────
// Sends a request for a live service, or records interest in one that is not
// live yet. A live request needs `consent: true`: the owner was shown exactly
// what would be shared and with whom, and tapped Send.
router.post('/requests', async (req, res) => {
  try {
    const body = req.body || {};
    const service = typeof body.service_id === 'string' ? getService(body.service_id) : null;
    const profile = await orgProfile(req.user.orgId);
    const visible = service && catalogueFor(profile).services.some((s) => s.id === service.id);
    if (!visible) return res.status(404).json({ success: false, message: 'That service was not found' });

    const base = {
      service_id: service.id,
      door: service.door,
      title: service.title,
      requested_by: req.user.id,
      requested_by_name: req.user.name || '',
    };

    // "Tell me when this is available": one row per service per organisation,
    // however often it is tapped, so the count of interested companies is honest.
    if (service.status === 'interest') {
      const existing = await ServiceRequest.findOne({ orgId: req.user.orgId, service_id: service.id, status: 'interest' });
      if (existing) return res.json({ success: true, message: 'We will tell you when this is available', data: sr.presentRequest(existing) });
      let created;
      try {
        created = await ServiceRequest.create({
          ...base,
          orgId: req.user.orgId,
          number: await numbering.next('SR'),
          status: 'interest',
          timeline: [{ status: 'interest', by: 'customer', note: 'You asked to hear when this is available' }],
        });
      } catch (err) {
        // Two taps at once: the other one won, which is the same outcome.
        const winner = err?.code === 11000
          && await ServiceRequest.findOne({ orgId: req.user.orgId, service_id: service.id, status: 'interest' });
        if (!winner) throw err;
        return res.json({ success: true, message: 'We will tell you when this is available', data: sr.presentRequest(winner) });
      }
      sr.auditChange({ req }, created, 'interest', null, { service_id: service.id });
      return res.status(201).json({ success: true, message: 'We will tell you when this is available', data: sr.presentRequest(created) });
    }

    if (body.consent !== true) {
      return res.status(400).json({ success: false, message: 'Please confirm what will be shared before sending' });
    }

    const { details, site, document_ids } = await validateDetails(service.needs, body.details, {
      findSite: (id) => Site.findOne({ _id: id, orgId: req.user.orgId }, '_id name').lean(),
      findDocument: (id) => require('../models/CompanyDocument')
        .findOne({ _id: id, orgId: req.user.orgId, status: 'active' }, '_id').lean(),
    });

    const requestId = clientRequestId(req);
    const now = new Date();
    const { record, replay } = await createOnce(ServiceRequest, req.user.orgId, requestId, {
      ...base,
      number: await numbering.next('SR'),
      status: 'requested',
      site_id: site?._id || null,
      site_name: site?.name || '',
      details,
      document_ids,
      consent: { shares: service.shares, shared_with: service.who, given_by: req.user.id, given_at: now },
      timeline: [{ at: now, status: 'requested', by: 'customer', note: 'We reply within one working day' }],
    });

    if (!replay) {
      sr.auditChange({ req }, record, 'create', null, { service_id: service.id, status: 'requested' });
    }
    return res.status(replay ? 200 : 201).json({ success: true, message: 'Request sent', data: sr.presentRequest(record) });
  } catch (err) {
    return fail(res, err, 'create');
  }
});

// ─── GET /api/services/requests ───────────────────────────────────────────────
// ?state=open (default: everything except interest), closed, interest, all.
const STATE_FILTERS = {
  open: { status: { $in: ServiceRequest.OPEN_STATUSES } },
  closed: { status: { $in: ['done', 'cancelled', 'declined'] } },
  interest: { status: 'interest' },
  all: {},
};

router.get('/requests', async (req, res) => {
  try {
    const state = String(req.query.state || 'requests');
    const filter = state === 'requests' ? { status: { $ne: 'interest' } } : STATE_FILTERS[state];
    if (!filter) return res.status(400).json({ success: false, message: 'Unknown state' });
    const rows = await ServiceRequest.find({ orgId: req.user.orgId, ...filter })
      .sort({ updatedAt: -1 }).limit(200).lean();
    return res.json({ success: true, data: rows.map(sr.presentRequestRow) });
  } catch (err) {
    return fail(res, err, 'list');
  }
});

// ─── GET /api/services/requests/:id ───────────────────────────────────────────
router.get('/requests/:id', async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid request id' });
    const r = await ServiceRequest.findOne({ _id: req.params.id, orgId: req.user.orgId }).lean();
    if (!r) return res.status(404).json({ success: false, message: 'Request not found' });
    return res.json({ success: true, data: sr.presentRequest(r) });
  } catch (err) {
    return fail(res, err, 'get');
  }
});

/** The routes that act on one request share the id check. */
const withId = (handler, route) => async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid request id' });
    const updated = await handler(req);
    return res.json({ success: true, data: sr.presentRequest(updated) });
  } catch (err) {
    return fail(res, err, route);
  }
};

// ─── POST /api/services/requests/:id/messages ─────────────────────────────────
router.post('/requests/:id/messages', withId(
  (req) => sr.addMessage({ req }, { _id: req.params.id, orgId: req.user.orgId }, req.body?.text), 'message'));

// ─── POST /api/services/requests/:id/choose ───────────────────────────────────
router.post('/requests/:id/choose', withId(
  (req) => sr.chooseOption(req, req.params.id, String(req.body?.option_id || '')), 'choose'));

// ─── POST /api/services/requests/:id/cancel ───────────────────────────────────
router.post('/requests/:id/cancel', withId(
  (req) => sr.cancel(req, req.params.id, req.body?.reason), 'cancel'));

// ─── POST /api/services/requests/:id/rating ───────────────────────────────────
// "Was this done well?" — once, after it is done (plan §10).
router.post('/requests/:id/rating', withId(async (req) => {
  const rating = req.body?.rating;
  if (!['good', 'bad'].includes(rating)) throw new sr.RequestError('Choose good or bad');
  const updated = await ServiceRequest.findOneAndUpdate(
    { _id: req.params.id, orgId: req.user.orgId, status: 'done', rating: null },
    { $set: { rating } },
    { new: true }
  );
  if (!updated) {
    const r = await ServiceRequest.findOne({ _id: req.params.id, orgId: req.user.orgId }, 'status rating').lean();
    if (!r) throw new sr.RequestError('Request not found', 404);
    throw new sr.RequestError(r.rating ? 'You have already rated this' : 'You can rate a request once it is done', 409);
  }
  audit.record(req, {
    action: 'service_request.rating', entity: 'service_request', entity_id: updated._id,
    entity_label: `${updated.number} · ${updated.title}`, after: { rating },
  });
  return updated;
}, 'rating'));

module.exports = router;
