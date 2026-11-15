// The company file, worked out (plan §5.3): which slots apply to this business,
// and whether each is in place, missing, expiring, expired or not needed.
//
// Pure functions of the profile, the sites and the documents, so the rules have
// one home and are tested without a database.

const { GROUPS, RULES, OTHER_SLOT } = require('../config/companyFileRules');
const { getService } = require('../config/serviceCatalogue');
const { presentProfile } = require('./orgProfile');
const { indiaClock } = require('./dailySummary');

const EXPIRING_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from today (India) to a date; negative once it has passed. */
function daysUntil(date, now = new Date()) {
  if (!date) return null;
  const today = Date.parse(`${indiaClock(now).day}T00:00:00Z`);
  const d = new Date(date);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((day - today) / DAY_MS);
}

/** One paper's own state: in place, expiring or expired. */
function documentState(doc, rule, now) {
  if (!rule?.expires || !doc.expires_on) return 'in_place';
  const days = daysUntil(doc.expires_on, now);
  if (days < 0) return 'expired';
  if (days <= EXPIRING_DAYS) return 'expiring';
  return 'in_place';
}

const WORST = ['expired', 'expiring', 'in_place'];

/** A slot's state from the papers in it. */
function slotStatus(rule, docs, notNeeded, now) {
  if (notNeeded) return 'not_needed';
  if (docs.length === 0) return 'missing';
  const states = docs.map((d) => documentState(d, rule, now));
  return WORST.find((s) => states.includes(s));
}

/** The profile with the derived worker total that rules read. */
function ruleProfile(profile) {
  const p = presentProfile(profile);
  return { ...p, workers: (p.own_workers || 0) + (p.contract_workers || 0) };
}

const presentFile = (doc) => ({
  id: doc._id,
  slot: doc.slot,
  title: doc.title || '',
  number: doc.number || '',
  issued_on: doc.issued_on ? doc.issued_on.toISOString().slice(0, 10) : null,
  expires_on: doc.expires_on ? doc.expires_on.toISOString().slice(0, 10) : null,
  days_left: doc.expires_on ? daysUntil(doc.expires_on) : null,
  site_id: doc.site_id || null,
  vehicle_label: doc.vehicle_label || '',
  note: doc.note || '',
  files: (doc.files || []).map((f, n) => ({ n, content_type: f.content_type, size: f.size })),
  uploaded_by_name: doc.uploaded_by_name || '',
  source: doc.source || 'upload',
  created_at: doc.createdAt,
});

/**
 * @param profile   Organization.profile
 * @param sites     [{_id, name}] — the organisation's sites
 * @param documents every active CompanyDocument row for the organisation
 */
function buildCompanyFile(profile, sites, documents, now = new Date()) {
  const p = ruleProfile(profile);
  const questions = new Set();
  const rows = [];

  const active = documents.filter((d) => d.status === 'active');
  const papers = active.filter((d) => !d.not_needed);
  const markers = active.filter((d) => d.not_needed);

  for (const rule of RULES) {
    // A slot whose rule depends on something the owner has not told us yet is
    // not shown; the question is offered instead. An answered list counts as
    // answered even when empty ("private clients only").
    const unknown = rule.asks.filter((f) => profile?.[f] === undefined || profile?.[f] === null);
    if (unknown.length) {
      unknown.forEach((f) => questions.add(f));
      continue;
    }
    if (!rule.applies(p)) continue;

    const targets = rule.per === 'site' ? sites.map((s) => ({ site_id: String(s._id), site_name: s.name })) : [{ site_id: null, site_name: '' }];
    for (const t of targets) {
      const match = (d) => d.slot === rule.slot && (rule.per === 'site' ? String(d.site_id) === t.site_id : true);
      const docs = papers.filter(match).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const notNeeded = markers.some(match);
      const status = slotStatus(rule, docs, notNeeded, now);
      const service = rule.service_id ? getService(rule.service_id) : null;
      const soonest = docs.filter((d) => d.expires_on).map((d) => daysUntil(d.expires_on, now));
      rows.push({
        slot: rule.slot,
        group: rule.group,
        title: rule.title,
        formal_name: rule.formal_name || null,
        basis: rule.basis,
        expires: rule.expires,
        multiple: Boolean(rule.multiple),
        site_id: t.site_id,
        site_name: t.site_name,
        status,
        days_left: soonest.length ? Math.min(...soonest) : null,
        service_id: service && service.status !== 'hidden' ? service.id : null,
        service_live: service?.status === 'live',
        documents: docs.map(presentFile),
      });
    }
  }

  const counted = rows.filter((r) => r.status !== 'not_needed');
  const ready = counted.filter((r) => r.status === 'in_place' || r.status === 'expiring').length;
  const count = (s) => rows.filter((r) => r.status === s).length;

  return {
    score: { ready, total: counted.length },
    counts: { in_place: count('in_place'), missing: count('missing'), expiring: count('expiring'), expired: count('expired'), not_needed: count('not_needed') },
    questions: [...questions],
    groups: GROUPS
      .map((g) => ({ id: g.id, title: g.title, slots: rows.filter((r) => r.group === g.id) }))
      .filter((g) => g.slots.length > 0),
    other: papers.filter((d) => d.slot === OTHER_SLOT).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(presentFile),
  };
}

module.exports = { buildCompanyFile, slotStatus, documentState, daysUntil, ruleProfile, presentFile, EXPIRING_DAYS };
