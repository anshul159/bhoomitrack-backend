const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const router = express.Router();
// No `auth` here on purpose — applied at the mount in server.js (PF-007).
const { ownerOnly } = require('../middleware/roles');
const Organization = require('../models/Organization');
const CompanyDocument = require('../models/CompanyDocument');
const Site = require('../models/Site');
const { getRule, isKnownSlot, OTHER_SLOT } = require('../config/companyFileRules');
const { buildCompanyFile, presentFile } = require('../utils/companyFile');
const { storage, StorageUnavailableError } = require('../utils/storage');
const audit = require('../utils/audit');
const { isObjectId } = require('../utils/validate');
const { captureError } = require('../utils/observability');

// The company file (BhoomiTrack Services, plan §5.3 and §6.3): the document
// locker and the compliance check in one. Owner only.
router.use(ownerOnly);

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 3;   // a licence's front and back, a policy's schedule and terms

// Multipart, held in memory: at 10 MB a file and three at most, the API never
// holds more than 30 MB for one upload, and nothing touches the disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 20, fieldSize: 4096 },
}).array('files', MAX_FILES);

// What the bytes are, whatever the client called them. HTML, SVG and anything
// else that can carry script is refused: these files are served back to people.
const SIGNATURES = [
  ['application/pdf', 'pdf', (b) => b.length > 5 && b.toString('latin1', 0, 5) === '%PDF-'],
  ['image/jpeg', 'jpg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', 'png', (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/webp', 'webp', (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'],
];
const sniff = (buffer) => SIGNATURES.find(([, , test]) => test(buffer)) || null;
const extensionFor = (type) => (SIGNATURES.find(([t]) => t === type) || [, 'bin'])[1];

class BadInput extends Error { constructor(m, status = 400) { super(m); this.status = status; } }

function fail(res, err, route) {
  if (err instanceof BadInput || err instanceof StorageUnavailableError) {
    return res.status(err.status).json({ success: false, message: err.message });
  }
  console.error(`[COMPANY FILE ${route}]`, err);
  captureError(err, { route: `companyFile.${route}` });
  return res.status(500).json({ success: false, message: 'Server error' });
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** A form date, 'YYYY-MM-DD', as midnight UTC; '' and absent are null. */
function formDate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new BadInput(`${label} is not a valid date`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1950 || d.getUTCFullYear() > 2100) {
    throw new BadInput(`${label} is not a valid date`);
  }
  return d;
}

/** The fields shared by upload and edit, checked against the slot's rule. */
function documentFields(body, rule) {
  const fields = {
    title: text(body.title, 120),
    number: text(body.number, 80),
    issued_on: formDate(body.issued_on, 'The issue date'),
    expires_on: formDate(body.expires_on, 'The expiry date'),
    vehicle_label: text(body.vehicle_label, 60),
    note: text(body.note, 500),
  };
  if (fields.issued_on && fields.expires_on && fields.expires_on < fields.issued_on) {
    throw new BadInput('The expiry date is before the issue date');
  }
  if (rule && !rule.expires) fields.expires_on = null;
  return fields;
}

async function siteFor(req, rule, siteId) {
  if (rule?.per !== 'site') return null;
  if (!isObjectId(siteId)) throw new BadInput('Choose the site this is for');
  const site = await Site.findOne({ _id: siteId, orgId: req.user.orgId }, '_id name').lean();
  if (!site) throw new BadInput('That site was not found');
  return site;
}

const findDoc = (req) => (isObjectId(req.params.id)
  ? CompanyDocument.findOne({ _id: req.params.id, orgId: req.user.orgId, not_needed: false })
  : null);

// ─── GET /api/company-file ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [org, sites, documents] = await Promise.all([
      Organization.findById(orgId, 'profile').lean(),
      Site.find({ orgId }, '_id name').sort({ name: 1 }).lean(),
      CompanyDocument.find({ orgId, status: 'active' }).lean(),
    ]);
    return res.json({ success: true, data: buildCompanyFile(org?.profile || {}, sites, documents) });
  } catch (err) {
    return fail(res, err, 'get');
  }
});

// ─── POST /api/company-file/documents ─────────────────────────────────────────
// multipart/form-data: `files` (1–3: PDF, JPEG, PNG or WebP, 10 MB each), and
// slot, title, number, issued_on, expires_on, site_id, vehicle_label, note.
router.post('/documents', (req, res, next) => {
  // Refuse before reading 10 MB off a phone's connection, not after.
  if (storage().name === 'none') return fail(res, new StorageUnavailableError(), 'upload');
  upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, message: 'A file can be at most 10 MB' });
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ success: false, message: `Attach at most ${MAX_FILES} files` });
    }
    return res.status(400).json({ success: false, message: 'The upload could not be read' });
  });
}, async (req, res) => {
  const stored = [];
  try {
    const body = req.body || {};
    const slot = text(body.slot, 60) || OTHER_SLOT;
    if (!isKnownSlot(slot)) throw new BadInput('Unknown kind of document');
    const rule = getRule(slot);

    const files = req.files || [];
    if (files.length === 0) throw new BadInput('Attach a photo or a PDF');
    const typed = files.map((f) => {
      const match = sniff(f.buffer);
      if (!match) throw new BadInput('Only PDF, JPEG, PNG and WebP files can be kept here');
      return { buffer: f.buffer, contentType: match[0] };
    });

    const fields = documentFields(body, rule);
    if (slot === OTHER_SLOT && !fields.title) throw new BadInput('Give the document a name');
    if (!fields.title) fields.title = rule.title;
    const site = await siteFor(req, rule, body.site_id);

    const doc = new CompanyDocument({
      orgId: req.user.orgId,
      slot,
      ...fields,
      site_id: site?._id || null,
      uploaded_by: req.user.id,
      uploaded_by_name: req.user.name || '',
    });
    for (const f of typed) {
      const key = `org/${req.user.orgId}/doc/${doc._id}/${crypto.randomUUID()}`;
      await storage().put(key, f.buffer, f.contentType);
      stored.push(key);
      doc.files.push({ key, content_type: f.contentType, size: f.buffer.length });
    }
    await doc.save();

    // A single-paper slot holds one paper: the new one replaces whatever was
    // there, and a "not needed" mark is lifted by uploading the paper after all.
    if (slot !== OTHER_SLOT) {
      const sameSlot = { orgId: req.user.orgId, slot, status: 'active', _id: { $ne: doc._id }, ...(site ? { site_id: site._id } : {}) };
      await CompanyDocument.deleteMany({ ...sameSlot, not_needed: true });
      if (!rule.multiple) await CompanyDocument.updateMany({ ...sameSlot, not_needed: false }, { $set: { status: 'replaced' } });
    }

    audit.record(req, {
      action: 'company_document.upload', entity: 'company_document', entity_id: doc._id,
      entity_label: doc.title, site_id: site?._id || null, site_name: site?.name || '',
      after: { slot, files: doc.files.length, expires_on: fields.expires_on },
    });
    return res.status(201).json({ success: true, message: 'Saved to your company file', data: presentFile(doc) });
  } catch (err) {
    // Nothing half-saved: files written before a failure are removed again.
    await Promise.all(stored.map((k) => storage().delete(k).catch(() => {})));
    return fail(res, err, 'upload');
  }
});

// ─── GET /api/company-file/documents/:id/file/:n ──────────────────────────────
// The file itself, streamed through the API. There is no public URL.
router.get('/documents/:id/file/:n', async (req, res) => {
  try {
    const doc = await findDoc(req);
    const n = Number(req.params.n);
    const file = doc && Number.isInteger(n) ? doc.files[n] : null;
    if (!file) return res.status(404).json({ success: false, message: 'Document not found' });

    const got = await storage().getStream(file.key);
    if (!got) return res.status(404).json({ success: false, message: 'Document not found' });

    const name = `${(doc.title || 'document').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'document'}${doc.files.length > 1 ? `-${n + 1}` : ''}.${extensionFor(file.content_type)}`;
    res.set({
      'Content-Type': file.content_type,
      'Content-Length': String(file.size),
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `inline; filename="${name}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    got.stream.on('error', (e) => { captureError(e, { route: 'companyFile.download' }); res.destroy(e); });
    return got.stream.pipe(res);
  } catch (err) {
    return fail(res, err, 'download');
  }
});

// ─── PUT /api/company-file/documents/:id ──────────────────────────────────────
// The paper's details. The files are replaced by uploading again.
router.put('/documents/:id', async (req, res) => {
  try {
    const doc = await findDoc(req);
    if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
    const rule = getRule(doc.slot);
    const merged = { ...presentFile(doc), ...(req.body || {}) };
    const fields = documentFields(merged, rule);
    if (!fields.title) fields.title = rule?.title || doc.title;

    const before = presentFile(doc);
    Object.assign(doc, fields);
    await doc.save();
    const after = presentFile(doc);
    const changed = audit.diff(before, after, ['title', 'number', 'issued_on', 'expires_on', 'vehicle_label', 'note']);
    if (changed) {
      audit.record(req, {
        action: 'company_document.update', entity: 'company_document', entity_id: doc._id,
        entity_label: doc.title, before: changed.before, after: changed.after,
      });
    }
    return res.json({ success: true, message: 'Saved', data: after });
  } catch (err) {
    return fail(res, err, 'update');
  }
});

// ─── DELETE /api/company-file/documents/:id ───────────────────────────────────
router.delete('/documents/:id', async (req, res) => {
  try {
    const doc = await findDoc(req);
    if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
    for (const f of doc.files) await storage().delete(f.key);
    await CompanyDocument.deleteOne({ _id: doc._id });
    audit.record(req, {
      action: 'company_document.delete', entity: 'company_document', entity_id: doc._id,
      entity_label: doc.title, before: { slot: doc.slot, files: doc.files.length },
    });
    return res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    return fail(res, err, 'delete');
  }
});

// ─── POST /api/company-file/slots/:slot/not-needed ────────────────────────────
// { not_needed: true | false, site_id? } — the owner's own call that a slot does
// not apply to them. It leaves the score, and can be put back.
router.post('/slots/:slot/not-needed', async (req, res) => {
  try {
    const rule = getRule(req.params.slot);
    if (!rule) return res.status(404).json({ success: false, message: 'Unknown kind of document' });
    const site = await siteFor(req, rule, req.body?.site_id);
    const where = { orgId: req.user.orgId, slot: rule.slot, status: 'active', not_needed: true, ...(site ? { site_id: site._id } : {}) };
    const want = req.body?.not_needed !== false;

    if (want) {
      const exists = await CompanyDocument.exists(where);
      if (!exists) {
        await CompanyDocument.create({ ...where, title: rule.title, site_id: site?._id || null, uploaded_by: req.user.id, uploaded_by_name: req.user.name || '' });
      }
    } else {
      await CompanyDocument.deleteMany(where);
    }
    audit.record(req, {
      action: want ? 'company_document.not_needed' : 'company_document.needed', entity: 'company_document',
      entity_label: rule.title, site_id: site?._id || null, site_name: site?.name || '', after: { slot: rule.slot },
    });
    return res.json({ success: true, message: want ? 'Marked as not needed' : 'Put back on your list', data: { slot: rule.slot, not_needed: want } });
  } catch (err) {
    return fail(res, err, 'notNeeded');
  }
});

module.exports = router;
module.exports.MAX_FILE_BYTES = MAX_FILE_BYTES;
