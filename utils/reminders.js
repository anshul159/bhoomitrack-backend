// Reminders for the company file and the compliance calendar (BhoomiTrack
// Services, plan §5.3 and §8 phase 1 step 5): a push 30, 7 and 1 days before a
// paper expires, and one a few days before a statutory due date.
//
// Pushes are for expiries, due dates and request updates only, never for a
// suggestion (plan §5.1 rule 6). Same pattern as the daily summary: run every few
// minutes by utils/scheduler.js, and each reminder is claimed in the database
// before it is sent, so a restart or a second instance cannot send it twice.

const CompanyDocument = require('../models/CompanyDocument');
const Organization = require('../models/Organization');
const User = require('../models/User');
const push = require('./push');          // a module, not destructured: tests stand in for it
const { getRule } = require('../config/companyFileRules');
const { dueWithin } = require('../config/complianceCalendar');
const { indiaClock } = require('./dailySummary');
const { loadCompanyFile, inPlaceSlots, daysUntil } = require('./companyFile');
const { presentProfile } = require('./orgProfile');

const EXPIRY_STEPS = [30, 7, 1];       // days before; the 1-day one also covers the day itself
const DUE_DAYS = 3;
const SEND_FROM_HOUR = 9;              // India time: nobody is woken by a licence at midnight
const DAY_MS = 24 * 60 * 60 * 1000;

/** The most urgent step a paper with `daysLeft` has reached, or null. */
function stepFor(daysLeft) {
  if (daysLeft === null || daysLeft < 0) return null;
  return [...EXPIRY_STEPS].reverse().find((s) => daysLeft <= s) ?? null;
}

const when = (d) => (d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`);

async function ownersOf(orgId) {
  return User.find({ orgId, role: { $in: ['owner', 'super_admin'] }, deletedAt: null }, 'fcmTokens fcmToken').lean();
}

/** One active organisation at a time, cached for the run. */
function activeOrgs(now) {
  const cache = new Map();
  return async (orgId) => {
    const key = String(orgId);
    if (!cache.has(key)) {
      const org = await Organization.findById(orgId);
      cache.set(key, org && org.isActive(now) ? org : null);
    }
    return cache.get(key);
  };
}

async function sendExpiryReminders({ now, send, orgOk }) {
  const { day } = indiaClock(now);
  const today = Date.parse(`${day}T00:00:00Z`);
  const docs = await CompanyDocument.find({
    status: 'active', not_needed: false,
    expires_on: { $gte: new Date(today), $lte: new Date(today + (EXPIRY_STEPS[0] + 1) * DAY_MS) },
  }).lean();

  let sent = 0;
  for (const doc of docs) {
    const rule = getRule(doc.slot);
    if (rule && !rule.expires) continue;
    const step = stepFor(daysUntil(doc.expires_on, now));
    if (step === null) continue;
    const expiresDay = doc.expires_on.toISOString().slice(0, 10);
    const tag = `${expiresDay}:${step}`;
    if ((doc.reminders_sent || []).includes(tag)) continue;
    if (!(await orgOk(doc.orgId))) continue;

    // Claim this step and every earlier one: a paper first seen at 5 days left
    // gets the 7-day reminder, and never a 30-day one after it.
    const tags = EXPIRY_STEPS.filter((s) => s >= step).map((s) => `${expiresDay}:${s}`);
    const claim = await CompanyDocument.updateOne(
      { _id: doc._id, reminders_sent: { $ne: tag } },
      { $addToSet: { reminders_sent: { $each: tags } } }
    );
    if (claim.modifiedCount !== 1) continue;

    const days = daysUntil(doc.expires_on, now);
    const name = doc.title || rule?.title || 'A document';
    await send(await ownersOf(doc.orgId), `${name} expires ${when(days)}`,
      'Open Services → Company file to renew it or upload the new one.',
      { type: 'company_document_expiry', documentId: String(doc._id), slot: doc.slot });
    sent += 1;
  }
  return sent;
}

async function sendDueDateReminders({ now, send }) {
  const { day } = indiaClock(now);
  // Only organisations that told us enough to have due dates: a GSTIN, or a
  // registration on file. The others have nothing but the universal dates, which
  // are not worth a push to someone who has never opened the tab.
  const orgs = await Organization.find({
    status: { $in: ['trialing', 'active'] },
    $or: [{ 'profile.gstin': { $ne: null } }, { _id: { $in: await CompanyDocument.distinct('orgId', { status: 'active', not_needed: false }) } }],
  }, '_id status trialEndsAt currentPeriodEnd services.reminders_sent');

  let sent = 0;
  for (const org of orgs) {
    if (!org.isActive(now)) continue;
    const { org: full, file } = await loadCompanyFile(org._id, now);
    const due = dueWithin({ profile: presentProfile(full?.profile), inPlace: inPlaceSlots(file) }, day, DUE_DAYS);
    for (const d of due) {
      const tag = `${d.id}:${d.due_on}`;
      const claim = await Organization.updateOne(
        { _id: org._id, 'services.reminders_sent': { $ne: tag } },
        { $addToSet: { 'services.reminders_sent': tag } }
      );
      if (claim.modifiedCount !== 1) continue;
      await send(await ownersOf(org._id), `${d.title} is due ${when(d.days_left)}`, `${d.line}. Check with your CA if it applies to you.`,
        { type: 'compliance_due', id: d.id, due_on: d.due_on });
      sent += 1;
    }
  }
  return sent;
}

/**
 * @returns {Promise<{ expiries: number, due_dates: number }>}
 */
async function sendServiceReminders({ now = new Date(), send = (...args) => push.sendToUsers(...args) } = {}) {
  if (indiaClock(now).hour < SEND_FROM_HOUR) return { expiries: 0, due_dates: 0 };
  const expiries = await sendExpiryReminders({ now, send, orgOk: activeOrgs(now) });
  const dueDates = await sendDueDateReminders({ now, send });
  return { expiries, due_dates: dueDates };
}

module.exports = { sendServiceReminders, stepFor, EXPIRY_STEPS };
