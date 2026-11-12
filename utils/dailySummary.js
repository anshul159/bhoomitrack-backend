// The owner's daily summary push (v2): one notification in the evening with the
// day's payments and deliveries across every site.
//
// Off unless the owner turns it on (User.notificationPrefs.dailySummary), at an
// hour they choose. Sent by utils/scheduler.js, which calls this every few
// minutes; this file decides who is due and sends to each at most once a day.

const User = require('../models/User');
const Organization = require('../models/Organization');
const push = require('./push');               // a module, not destructured: tests stand in for it
const { summarise } = require('./recordsSummary');
const { formatRupees } = require('./money');

// Every customer is in India and the organisation has no timezone of its own,
// so "today" is the India day. IST has no daylight saving, so a fixed offset is
// exact.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * The India-time calendar day and hour at `now`, and the instant that day began.
 * @returns {{ day: string, hour: number, dayStart: Date }}
 */
function indiaClock(now = new Date()) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  return {
    day: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    dayStart: new Date(
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - IST_OFFSET_MS
    ),
  };
}

const countOf = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The notification itself, from a summarise() result. */
function summaryMessage(summary) {
  const t = summary.totals;
  const title = 'Today at your sites';

  if (t.payments_count === 0 && t.arrivals_count === 0) {
    return {
      title,
      body: t.site_count === 0
        ? 'No sites yet.'
        : 'No payments or deliveries were recorded at any site today.',
    };
  }

  const parts = [
    t.payments_count > 0
      ? `${formatRupees(t.payments_amount)} paid (${countOf(t.payments_count, 'payment')})`
      : 'No payments',
    t.arrivals_count > 0 ? `${countOf(t.arrivals_count, 'load')} arrived` : 'no loads arrived',
  ];
  const quiet = t.site_count - t.active_site_count;
  if (quiet > 0) parts.push(`${countOf(quiet, 'site')} recorded nothing`);
  return { title, body: parts.join(' · ') };
}

/**
 * Sends today's summary to every owner who is due: opted in, past their chosen
 * hour, and not yet sent today.
 *
 * Each owner's day is claimed in the database before their notification goes,
 * so a restart mid-run or a second instance on the same tick cannot send it
 * twice. The cost is that a send which fails after the claim is not retried that
 * day — one missed summary is better than a duplicated one, which is the exact
 * complaint this feature must not earn.
 *
 * @returns {Promise<{ sent: number, day: string }>}
 */
async function sendDailySummaries({ now = new Date(), send = (...args) => push.sendToUsers(...args) } = {}) {
  const { day, hour, dayStart } = indiaClock(now);

  const due = await User.find({
    role: { $in: ['owner', 'super_admin'] },
    deletedAt: null,
    'notificationPrefs.dailySummary': true,
    'notificationPrefs.dailySummaryHour': { $lte: hour },
    dailySummarySentFor: { $ne: day },
  }, '_id orgId fcmTokens fcmToken').lean();
  if (due.length === 0) return { sent: 0, day };

  const byOrg = new Map();
  for (const owner of due) {
    if (!owner.orgId) continue;
    const key = String(owner.orgId);
    if (!byOrg.has(key)) byOrg.set(key, []);
    byOrg.get(key).push(owner);
  }

  let sent = 0;
  for (const [orgId, owners] of byOrg) {
    // A company whose subscription has lapsed cannot open these numbers in the
    // app (402), so they are not pushed to it either.
    const org = await Organization.findById(orgId);
    if (!org || !org.isActive(now)) continue;

    const { title, body } = summaryMessage(await summarise(orgId, { from: dayStart, to: now }));

    for (const owner of owners) {
      const claim = await User.updateOne(
        { _id: owner._id, dailySummarySentFor: { $ne: day } },
        { $set: { dailySummarySentFor: day } }
      );
      if (claim.modifiedCount !== 1) continue;
      await send([owner], title, body, { type: 'daily_summary', day });
      sent += 1;
    }
  }
  return { sent, day };
}

module.exports = { sendDailySummaries, summaryMessage, indiaClock };
