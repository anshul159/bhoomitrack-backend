const express = require('express');
const router = express.Router();
// No `auth` here on purpose — applied at the mount in server.js (PF-007).
const { ownerOnly, requireApproved } = require('../middleware/roles');
const siteAccess = require('../middleware/siteAccess');
const ProgressUpdate = require('../models/ProgressUpdate');
const Attachment = require('../models/Attachment');
const { parsePaging, paginate } = require('../utils/pagination');
const { decodeImage } = require('../utils/billImage');
const { STALE_AFTER_DAYS } = require('../utils/siteProgress');
const audit = require('../utils/audit');
const {
  ValidationError, writableSite, optionalText, eventDate, clientRequestId, createOnce, periodFilter, voidHandler,
} = require('../utils/siteRecords');

// Progress updates (v2): how much of a site's work is done, reported every few
// days by its engineer (the site's manager). Owners see it and may void a wrong
// update, but do not record it, so the history only ever shows the engineer. A record, not a request — see
// models/ProgressUpdate.js. Owners compare it with the budget through
// /api/budgets; managers see the updates but never the budget.

const PHOTO_LABEL = 'The photo';

const updateToResponse = (p) => ({
  id: p._id,
  site_id: p.site_id,
  site_name: p.site_name,
  percent: p.percent,
  work_done: p.work_done || '',
  as_of: p.as_of,
  photo_attachment_id: p.photo_attachment_id || null,
  has_photo: Boolean(p.photo_attachment_id),
  recorded_by_name: p.recorded_by_name || '',
  recorded_by_role: p.recorded_by_role || '',
  status: p.status,
  void_reason: p.void_reason || '',
  voided_at: p.voided_at || null,
  created_at: p.createdAt,
});

/** 0-100, to one decimal place. A string is accepted: forms send what was typed. */
function parsePercent(value) {
  if (value === undefined || value === null || value === '') throw new ValidationError('Enter how much of the work is done (0-100%)');
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ValidationError('Progress must be a number between 0 and 100');
  if (n < 0 || n > 100) throw new ValidationError('Progress must be between 0 and 100%');
  return Math.round(n * 10) / 10;
}

const latestRecorded = (orgId, siteId) =>
  ProgressUpdate.findOne({ orgId, site_id: siteId, status: 'recorded' }).sort({ as_of: -1, createdAt: -1, _id: -1 });

// ─── POST /api/progress ───────────────────────────────────────────────────────
// A manager records for their own site. Owners are refused (BT-220): the
// engineer reports how far the work has got, the owner compares it with the money.
const OWNER_REFUSAL = 'Progress is reported by the site engineer. Owners see it and can void a wrong update.';

router.post('/', requireApproved, async (req, res) => {
  if (req.user.role !== 'manager') {
    return res.status(403).json({ success: false, message: OWNER_REFUSAL });
  }
  let attachment = null;
  try {
    const body = req.body || {};
    const requestId = clientRequestId(req);

    // A retry of an update that already landed: answer before decoding the
    // photo again or storing a second copy of it.
    if (requestId) {
      const existing = await ProgressUpdate.findOne({ orgId: req.user.orgId, client_request_id: requestId });
      if (existing) {
        return res.json({ success: true, message: 'Progress saved', data: updateToResponse(existing), idempotent_replay: true });
      }
    }

    const where = await writableSite(req, body.site_name);
    if (where.status) return res.status(where.status).json({ success: false, message: where.message });
    const { site } = where;

    const doc = {
      site_id: site._id,
      site_name: site.name,
      percent: parsePercent(body.percent),
      work_done: optionalText(body.work_done, 500, 'What was done'),
      as_of: eventDate(body.as_of, 'Progress date'),
      recorded_by: req.user.id,
      recorded_by_name: req.user.name || '',
      recorded_by_role: req.user.role,
    };

    if (body.photo_image !== undefined && body.photo_image !== null && body.photo_image !== '') {
      const image = decodeImage(body.photo_image, PHOTO_LABEL);
      if (image.error) throw new ValidationError(image.error);
      attachment = await Attachment.create({
        orgId: req.user.orgId,
        site_id: site._id,
        kind: 'progress',
        content_type: image.contentType,
        size: image.buffer.length,
        data: image.buffer,
        uploaded_by: req.user.id,
      });
      doc.photo_attachment_id = attachment._id;
    }

    const previous = await latestRecorded(req.user.orgId, site._id).lean();
    const { record, replay } = await createOnce(ProgressUpdate, req.user.orgId, requestId, doc);
    if (replay && attachment) {
      // Lost the race to an identical retry: that one's photo is the one kept.
      await Attachment.deleteOne({ _id: attachment._id });
      attachment = null;
    }

    if (!replay) {
      audit.record(req, {
        action: 'progress.record',
        entity: 'progress',
        entity_id: record._id,
        entity_label: `${record.percent}% at ${site.name}`,
        site_id: site._id,
        site_name: site.name,
        before: previous ? { percent: previous.percent } : undefined,
        after: { percent: record.percent, has_photo: Boolean(record.photo_attachment_id) },
      });
    }

    return res.json({
      success: true,
      message: 'Progress saved',
      data: updateToResponse(record),
      // What the site stood at before this one, so the app can say "up from 40%".
      previous_percent: previous && String(previous._id) !== String(record._id) ? previous.percent : null,
      ...(replay ? { idempotent_replay: true } : {}),
    });
  } catch (err) {
    // A stored photo with no update pointing at it is an orphan nobody can see.
    if (attachment) await Attachment.deleteOne({ _id: attachment._id }).catch(() => {});
    if (err instanceof ValidationError) return res.status(400).json({ success: false, message: err.message });
    console.error('[PROGRESS RECORD]', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/progress/:site ──────────────────────────────────────────────────
// Newest first by the day assessed, void entries included (shown struck
// through) so the history is complete. `latest` is the newest recorded one —
// the site's current progress. Optional ?from=&to= bound the list by `as_of`;
// `latest` is never bounded, because the current figure does not depend on
// which page of history is being read.
router.get('/:site', siteAccess, async (req, res) => {
  try {
    const filter = { orgId: req.user.orgId, site_id: req.site._id, ...periodFilter(req.query, 'as_of') };
    const paging = parsePaging(req.query, { defaultLimit: 100 });

    const [result, latest] = await Promise.all([
      paginate(ProgressUpdate, filter, paging, { as_of: -1, createdAt: -1 }, updateToResponse),
      latestRecorded(req.user.orgId, req.site._id).lean(),
    ]);

    return res.json({
      success: true,
      message: 'OK',
      ...result,
      latest: latest ? updateToResponse(latest) : null,
      stale_after_days: STALE_AFTER_DAYS,
    });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ success: false, message: err.message });
    console.error('[PROGRESS LIST]', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/progress/void/:id ───────────────────────────────────────────────
// Voiding the latest update makes the one before it current again.
router.put('/void/:id', ownerOnly, voidHandler(ProgressUpdate, {
  entity: 'progress',
  noun: 'progress update',
  label: (p) => `${p.percent}% at ${p.site_name}`,
  format: updateToResponse,
}));

module.exports = router;
