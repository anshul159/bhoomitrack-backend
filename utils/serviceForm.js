// Validates a request form's answers against the catalogue's `needs` (plan §6.1).
//
// The app renders the form from the same `needs`, so in the ordinary case this
// only confirms what the app already checked. It is still the control: the
// stored `details` are exactly the keys the catalogue asked for, in the shape it
// declared, and nothing else.

const { isObjectId } = require('./validate');

const MAX_TEXT = 1000;
const MAX_NUMBER = 1e9;
const MAX_MONEY = 1e11;   // ₹1,000 crore: above any contract a customer of ours signs

class FormError extends Error {
  constructor(message, field) { super(message); this.field = field; this.status = 400; }
}

/**
 * @param needs    the catalogue entry's `needs`
 * @param details  what the app sent
 * @param ctx      { findSite(id) → site|null, findDocument(id) → doc|null }, both scoped to the organisation
 * @returns {Promise<{ details: object, site: object|null, document_ids: string[] }>}
 * @throws FormError
 */
async function validateDetails(needs, details, ctx) {
  const input = details && typeof details === 'object' && !Array.isArray(details) ? details : {};
  const out = {};
  let site = null;
  const documentIds = [];

  for (const need of needs) {
    const raw = input[need.key];
    const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
    if (empty) {
      if (need.required) throw new FormError(`${need.label} is needed`, need.key);
      continue;
    }

    switch (need.type) {
      case 'text':
      case 'material': {
        if (typeof raw !== 'string') throw new FormError(`${need.label} could not be read`, need.key);
        const v = raw.trim();
        if (v.length > (need.type === 'material' ? 120 : MAX_TEXT)) throw new FormError(`${need.label} is too long`, need.key);
        out[need.key] = v;
        break;
      }
      case 'number': {
        const v = typeof raw === 'string' ? Number(raw) : raw;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_NUMBER) {
          throw new FormError(`${need.label} must be a number`, need.key);
        }
        out[need.key] = v;
        break;
      }
      case 'money': {
        const v = typeof raw === 'string' ? Number(raw.replace(/,/g, '')) : raw;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_MONEY) {
          throw new FormError(`${need.label} must be an amount in rupees`, need.key);
        }
        out[need.key] = Math.round(v * 100) / 100;
        break;
      }
      case 'date': {
        const s = String(raw);
        const d = new Date(s);
        if (!/^\d{4}-\d{2}-\d{2}/.test(s) || Number.isNaN(d.getTime())) throw new FormError(`${need.label} is not a valid date`, need.key);
        out[need.key] = s.slice(0, 10);
        break;
      }
      case 'choice': {
        if (!need.options.includes(raw)) throw new FormError(`Choose one of the options for ${need.label.toLowerCase()}`, need.key);
        out[need.key] = raw;
        break;
      }
      case 'site': {
        if (!isObjectId(raw)) throw new FormError('Choose a site', need.key);
        site = await ctx.findSite(String(raw));
        if (!site) throw new FormError('That site was not found', need.key);
        out[need.key] = String(site._id);
        break;
      }
      case 'document': {
        if (!isObjectId(raw)) throw new FormError(`${need.label} was not found`, need.key);
        const doc = ctx.findDocument ? await ctx.findDocument(String(raw)) : null;
        if (!doc) throw new FormError(`${need.label} was not found`, need.key);
        out[need.key] = String(doc._id);
        documentIds.push(String(doc._id));
        break;
      }
      case 'workers':
        // Phase 2: the Workers list. Until it exists there is nothing to pick.
        throw new FormError(`${need.label} cannot be chosen yet`, need.key);
      default:
        throw new FormError(`${need.label} could not be read`, need.key);
    }
  }
  return { details: out, site, document_ids: documentIds };
}

module.exports = { validateDetails, FormError };
