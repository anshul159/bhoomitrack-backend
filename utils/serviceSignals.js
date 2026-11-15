// "For you" (BhoomiTrack Services, plan §5.1 rule 6 and §6.5): at most two
// suggestions, worked out from the company's own data.
//
// Pure functions from what is already known to a ranked list. The route shows
// the top two that the owner has not dismissed. Credit is never suggested here,
// in any phase (plan §4.2, D4): a contractor who is behind on a site should not
// be chased with loan offers by the app that knows it.

const { getService } = require('../config/serviceCatalogue');
const { dueWithin } = require('../config/complianceCalendar');

const SHOWN = 2;
const DUE_SOON_DAYS = 5;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const inDays = (n) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`);

// Titles are used exactly as written: lowercasing the first letter turned
// "PAN card" into "pAN card" and "Udyam" into "udyam".
const where = (slot) => (slot.site_name ? ` at ${slot.site_name}` : '');

/** A live service that can be requested, never a credit one. */
const actionable = (serviceId) => {
  const s = serviceId ? getService(serviceId) : null;
  return s && s.status === 'live' && s.door !== 'credit' ? s : null;
};

/** Papers that have expired or expire within 30 days. */
function expirySignals(companyFile) {
  const out = [];
  for (const slot of companyFile.groups.flatMap((g) => g.slots)) {
    if (slot.status !== 'expired' && slot.status !== 'expiring') continue;
    const service = actionable(slot.service_id);
    const expired = slot.status === 'expired';
    out.push({
      id: `expiry:${slot.slot}:${slot.site_id || ''}:${slot.status}`,
      kind: 'expiry',
      service_id: service?.id || null,
      slot: slot.slot,
      site_id: slot.site_id || null,
      title: expired
        ? `${slot.title}${where(slot)} has expired`
        : `${slot.title}${where(slot)} expires ${inDays(slot.days_left)}`,
      line: service ? 'Get it renewed for you' : 'Upload the new one when you have it',
      priority: expired ? 100 : 90 - Math.max(0, slot.days_left || 0),
    });
  }
  return out;
}

/** Statutory dates within five days. */
function dueDateSignals(context, today) {
  return dueWithin(context, today, DUE_SOON_DAYS).map((d) => {
    const service = actionable(d.service_id);
    return {
      id: `due:${d.id}:${d.due_on}`,
      kind: 'due_date',
      service_id: service?.id || null,
      title: `${d.title} is due ${d.days_left <= 1 ? inDays(d.days_left) : `on ${shortDate(d.due_on)}`}`,
      line: service ? `${d.line}. We can file it for you` : d.line,
      priority: 80 - d.days_left,
    };
  });
}

/** A slot that applies, is missing, and that we can get done. */
function missingSignals(companyFile) {
  return companyFile.groups.flatMap((g) => g.slots)
    .filter((s) => s.status === 'missing' && actionable(s.service_id))
    .map((s, i) => ({
      id: `missing:${s.slot}:${s.site_id || ''}`,
      kind: 'missing',
      service_id: s.service_id,
      slot: s.slot,
      site_id: s.site_id || null,
      title: `${s.title}${where(s)} is not on file`,
      line: 'Upload it, or let us get it done for you',
      priority: 50 - i,          // the rules file's order: the more basic papers first
    }));
}

/**
 * Every signal, ranked.
 * @param companyFile  buildCompanyFile()'s result
 * @param context      { profile, inPlace: Set } for the calendar
 * @param today        'YYYY-MM-DD', India
 */
function allSignals(companyFile, context, today) {
  return [...expirySignals(companyFile), ...dueDateSignals(context, today), ...missingSignals(companyFile)]
    .sort((a, b) => b.priority - a.priority);
}

/** The ones to show: not dismissed, at most two. */
function topSignals(signals, dismissed = [], now = new Date()) {
  const hidden = new Set(dismissed.filter((d) => new Date(d.until) > now).map((d) => d.signal_id));
  return signals.filter((s) => !hidden.has(s.id)).slice(0, SHOWN)
    .map(({ priority, ...rest }) => rest);
}

module.exports = { allSignals, topSignals, expirySignals, dueDateSignals, missingSignals, SHOWN };
