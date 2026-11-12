// Shared rules for the v2 site records: payments and material arrivals.
//
// Both are records of something that already happened at a site, written by the
// site's manager or by an owner, never edited, and voided (not deleted) by an
// owner with a reason. Keeping those rules here means the two routes cannot drift
// apart on who may write where, or on how a retry is recognised.

const { resolveSite } = require('./site');
const { isDuplicateKeyError } = require('./duplicateKey');
const { isNonEmptyString, isObjectId } = require('./validate');
const audit = require('./audit');

/** A 400 with a message meant for the person filling in the form. */
class ValidationError extends Error {}

const isOwnerRole = (user) => user.role === 'owner' || user.role === 'super_admin';

/**
 * The site a record is being written for. Owners may write for any site in their
 * organisation; a manager only for a site they are assigned to, and when they
 * name none, their own.
 * @returns {Promise<{site} | {status, message}>}
 */
async function writableSite(req, siteParam) {
  const owner = isOwnerRole(req.user);
  const requested = owner ? siteParam : (siteParam || req.user.site_name);
  const site = await resolveSite(requested, req.user.orgId);
  if (!site) {
    return owner
      ? { status: 404, message: 'Site not found' }
      : { status: 400, message: 'You are not assigned to a site yet' };
  }
  if (!owner && !mayManagerSee(req.user, site)) {
    return { status: 403, message: 'You are not assigned to this site' };
  }
  return { site };
}

/** Whether a manager is assigned to `site` (an object with _id and name, or an id). */
function mayManagerSee(user, site) {
  const id = String(site._id || site);
  return (user.site_ids || []).map(String).includes(id) ||
    (Boolean(user.site_name) && user.site_name === site.name);
}

/** Optional free text: '' when absent, trimmed, refused when too long. */
function optionalText(value, max, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ValidationError(`${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ValidationError(`${label} must be ${max} characters or fewer`);
  return trimmed;
}

function requiredText(value, max, label) {
  if (!isNonEmptyString(value, max * 4)) throw new ValidationError(`${label} is required`);
  return optionalText(value, max, label);
}

/**
 * Vehicle registration as people write it on a slip: "ka 01 ab 1234",
 * "KA01AB1234", "KA-01-AB-1234". Stored upper-case with single spaces so the
 * same vehicle reads the same way in every record. Format is not enforced —
 * temporary and older plates do not follow the modern pattern.
 */
function vehicleNumber(value, { required }) {
  const raw = required ? requiredText(value, 20, 'Vehicle number') : optionalText(value, 20, 'Vehicle number');
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9 -]/g, '').replace(/\s+/g, ' ').trim();
  if (raw && !cleaned) throw new ValidationError('Vehicle number must contain letters or digits');
  return cleaned;
}

/** Optional Indian phone number, kept as digits (with any leading +). */
function phoneNumber(value, label) {
  const raw = optionalText(value, 20, label);
  if (!raw) return '';
  const cleaned = raw.replace(/[\s-]/g, '');
  if (!/^\+?\d{10,13}$/.test(cleaned)) throw new ValidationError(`${label} must be a 10-digit phone number`);
  return cleaned;
}

/**
 * When something happened. Defaults to now. A date may be back-dated (entries
 * are often made the evening after) but not more than a day ahead, which allows
 * for a phone a timezone off and nothing else.
 */
function eventDate(value, label) {
  if (value === undefined || value === null || value === '') return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${label} is not a valid date`);
  if (date.getTime() > Date.now() + 24 * 60 * 60 * 1000) throw new ValidationError(`${label} cannot be in the future`);
  if (date.getFullYear() < 2000) throw new ValidationError(`${label} is not a valid date`);
  return date;
}

/** The client's idempotency key, from the body or the conventional header. */
function clientRequestId(req) {
  const id = String(req.body?.client_request_id || req.get('Idempotency-Key') || '').trim() || null;
  if (id && id.length > 100) throw new ValidationError('Invalid request id');
  return id;
}

/**
 * Creates a record, or returns the one an earlier attempt with the same
 * idempotency key already created. The lookup handles a retry after the first
 * attempt finished; the unique index handles one that races it (PF-003).
 * @returns {Promise<{record, replay: boolean}>}
 */
async function createOnce(Model, orgId, requestId, doc) {
  if (requestId) {
    const existing = await Model.findOne({ orgId, client_request_id: requestId });
    if (existing) return { record: existing, replay: true };
  }
  try {
    return { record: await Model.create({ ...doc, orgId, client_request_id: requestId }), replay: false };
  } catch (err) {
    if (requestId && isDuplicateKeyError(err)) {
      const winner = await Model.findOne({ orgId, client_request_id: requestId });
      if (winner) return { record: winner, replay: true };
    }
    throw err;
  }
}

/**
 * Optional `from` / `to` query bounds on a date field, both inclusive.
 * `to` given as a bare date means the whole of that day.
 */
function periodFilter(query, field) {
  const range = {};
  for (const [key, op] of [['from', '$gte'], ['to', '$lte']]) {
    if (!query[key]) continue;
    const date = new Date(query[key]);
    if (Number.isNaN(date.getTime())) throw new ValidationError(`'${key}' is not a valid date`);
    if (key === 'to' && /^\d{4}-\d{2}-\d{2}$/.test(String(query[key]))) {
      date.setUTCHours(23, 59, 59, 999);
    }
    range[op] = date;
  }
  return Object.keys(range).length ? { [field]: range } : {};
}

/**
 * PUT /void/:id — owner only. Atomically moves a record from recorded to void,
 * so two owners voiding at once cannot both write a reason.
 *
 * `entity` names the record in the audit log ("payment" → payment.void); `noun`
 * is what the messages call it, when that differs ("progress update").
 */
function voidHandler(Model, { entity, noun = entity, label, format }) {
  const Noun = `${noun[0].toUpperCase()}${noun.slice(1)}`;
  return async (req, res) => {
    try {
      if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: `Invalid ${noun} id` });
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (reason.length < 3 || reason.length > 500) {
        return res.status(400).json({ success: false, message: 'Give a reason for voiding (3-500 characters)' });
      }

      const record = await Model.findOneAndUpdate(
        { _id: req.params.id, orgId: req.user.orgId, status: 'recorded' },
        { status: 'void', void_reason: reason, voided_by: req.user.id, voided_at: new Date() },
        { new: true }
      );
      if (!record) {
        const exists = await Model.exists({ _id: req.params.id, orgId: req.user.orgId });
        return exists
          ? res.status(400).json({ success: false, message: `This ${noun} is already void` })
          : res.status(404).json({ success: false, message: `${Noun} not found` });
      }

      audit.record(req, {
        action: `${entity}.void`,
        entity,
        entity_id: record._id,
        entity_label: label(record),
        site_id: record.site_id,
        site_name: record.site_name,
        before: { status: 'recorded' },
        after: { status: 'void' },
        note: reason,
      });

      return res.json({ success: true, message: `${Noun} voided`, data: format(record) });
    } catch (err) {
      console.error(`[${entity.toUpperCase()} VOID]`, err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  };
}

module.exports = {
  ValidationError, isOwnerRole, writableSite, mayManagerSee,
  optionalText, requiredText, vehicleNumber, phoneNumber, eventDate,
  clientRequestId, createOnce, periodFilter, voidHandler,
};
