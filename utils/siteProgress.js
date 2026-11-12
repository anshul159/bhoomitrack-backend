const mongoose = require('mongoose');
const Site = require('../models/Site');
const SitePayment = require('../models/SitePayment');
const SiteBudget = require('../models/SiteBudget');
const ProgressUpdate = require('../models/ProgressUpdate');

// Budget against money paid against work done, for one site or every site (v2).
//
// The small-project method from the Manas conversation (2026-11-10). Where work
// is not itemised, nothing can count progress for you: the owner sets what the
// site should cost, the payments say what it has cost so far, and the
// engineer's update says how much of the work that money bought. Money running
// ahead of the work is the early warning. In Manas's words most sites finish
// within 5-10% of their budget, so a projection more than 10% over is the line.
//
// Every derived number names its method (`assessment.method`): a projection made
// from a percentage somebody estimated is itself an estimate, and the owner
// should be able to see how it was made.
//
// One function behind both GET /api/budgets/:site and GET /api/budgets, so the
// site screen and the owner's list can never disagree about a number.

/** A projection up to 10% over budget still reads as on track — Manas's 5-10% band. */
const PACE_TOLERANCE = 0.10;
/** Below 10% done, paid ÷ done is mostly noise: material is bought before it is used. */
const MIN_PROGRESS_TO_PROJECT = 10;
/** The engineer updates every 3-7 days; past a week the owner is told it is stale. */
const STALE_AFTER_DAYS = 7;

const THRESHOLDS = {
  pace_tolerance_percent: PACE_TOLERANCE * 100,
  min_progress_to_project: MIN_PROGRESS_TO_PROJECT,
  stale_after_days: STALE_AFTER_DAYS,
};

const METHOD = 'Projected cost = paid so far ÷ work done';

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;
const categoryOrder = (c) => {
  const i = SitePayment.CATEGORIES.indexOf(c);
  return i < 0 ? SitePayment.CATEGORIES.length : i;
};

/**
 * Where a site stands against its budget.
 *
 *   no_budget — nothing to compare with yet
 *   over      — more has been paid than the whole budget
 *   early     — under 10% done, or nothing paid yet: too soon to project
 *   watch     — at this rate the site will cost more than budget + 10%
 *   on_track  — at this rate it will finish within budget + 10%
 */
function assess(budget, spent, percent) {
  const out = {
    status: 'no_budget',
    spent_percent: null,
    remaining: null,
    projected_cost: null,
    projected_over: null,
    projected_over_percent: null,
    method: METHOD,
  };
  if (budget == null) return out;

  out.spent_percent = round1((spent / budget) * 100);
  out.remaining = round2(budget - spent);
  // Nothing paid yet projects to ₹0, which is not a prediction of anything.
  if (percent != null && percent >= MIN_PROGRESS_TO_PROJECT && spent > 0) {
    const projected = spent / (percent / 100);
    out.projected_cost = round2(projected);
    out.projected_over = round2(projected - budget);
    out.projected_over_percent = round1(((projected - budget) / budget) * 100);
  }

  if (spent > budget) out.status = 'over';
  else if (out.projected_cost == null) out.status = 'early';
  else if (out.projected_cost > budget * (1 + PACE_TOLERANCE)) out.status = 'watch';
  else out.status = 'on_track';
  return out;
}

/**
 * One head of the budget against the work done — the same rule as the whole
 * site, applied to the head, so "which head is running ahead" can be answered.
 *
 *   null   — the head has no budget of its own
 *   over   — more paid under it than its budget
 *   ahead  — its share of the head is more than the work done, by over 10%
 *            (only once 10% of the work is done — before that, too early)
 *   ok     — otherwise
 */
function headPace(head, total, percent) {
  if (head == null) return null;
  if (total > head) return 'over';
  if (percent != null && percent >= MIN_PROGRESS_TO_PROJECT && head > 0 &&
      (total / head) * 100 > percent * (1 + PACE_TOLERANCE)) return 'ahead';
  return 'ok';
}

const sortHeads = (heads) => [...heads].sort((a, b) => categoryOrder(a.category) - categoryOrder(b.category));

function budgetToResponse(b, { detail }) {
  const heads = sortHeads(b.heads || []).map((h) => ({ category: h.category, amount: h.amount }));
  const allocated = round2(heads.reduce((sum, h) => sum + h.amount, 0));
  return {
    amount: b.amount,
    heads,
    allocated,
    unallocated: round2(b.amount - allocated),
    note: b.note || '',
    original_amount: b.original_amount ?? b.amount,
    revision: b.revision,
    set_at: b.set_at,
    set_by_name: b.set_by_name || '',
    // Newest first: the screen lists what it was revised from, most recent on top.
    ...(detail ? {
      history: [...(b.history || [])].reverse().map((h) => ({
        amount: h.amount,
        heads: sortHeads(h.heads || []).map((x) => ({ category: x.category, amount: x.amount })),
        note: h.note || '',
        revision: h.revision,
        set_at: h.set_at,
        set_by_name: h.set_by_name || '',
      })),
    } : {}),
  };
}

function progressToSummary(p, now) {
  if (!p) return null;
  const daysSince = Math.max(0, Math.floor((now - new Date(p.as_of).getTime()) / DAY_MS));
  return {
    id: p._id,
    percent: p.percent,
    as_of: p.as_of,
    work_done: p.work_done || '',
    has_photo: Boolean(p.photo_attachment_id),
    recorded_by_name: p.recorded_by_name || '',
    days_since: daysSince,
    stale: daysSince > STALE_AFTER_DAYS,
  };
}

/**
 * @param site     { _id, name }
 * @param budget   a SiteBudget document, or null
 * @param payRows  [{ category, total, count }] of recorded payments at the site
 * @param latest   the latest recorded ProgressUpdate, or null
 */
function build(site, budget, payRows, latest, { detail, now }) {
  const headBudget = new Map((budget?.heads || []).map((h) => [h.category, h.amount]));
  const paid = new Map(payRows.map((r) => [r.category, r]));
  const progress = progressToSummary(latest, now);
  // Every head that was paid against or budgeted for: a budgeted head with no
  // payments yet is a line the owner wants to see at ₹0.
  const byCategory = [...new Set([...paid.keys(), ...headBudget.keys()])]
    .sort((a, b) => categoryOrder(a) - categoryOrder(b))
    .map((category) => {
      const total = round2(paid.get(category)?.total || 0);
      const head = headBudget.has(category) ? headBudget.get(category) : null;
      return {
        category, total, count: paid.get(category)?.count || 0, budget: head,
        over: head != null && total > head,
        pace: headPace(head, total, progress ? progress.percent : null),
      };
    });

  const spentTotal = round2(payRows.reduce((sum, r) => sum + r.total, 0));

  return {
    site_id: site._id,
    site_name: site.name,
    budget: budget ? budgetToResponse(budget, { detail }) : null,
    spent: {
      total: spentTotal,
      count: payRows.reduce((sum, r) => sum + r.count, 0),
      by_category: byCategory,
    },
    progress,
    assessment: assess(budget ? budget.amount : null, spentTotal, progress ? progress.percent : null),
  };
}

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

/** One site, with its budget history. */
async function siteOverview(orgIdValue, site) {
  const orgId = toObjectId(orgIdValue);
  const siteId = toObjectId(site._id);
  const [budget, payRows, latest] = await Promise.all([
    SiteBudget.findOne({ orgId, site_id: siteId }).lean(),
    SitePayment.aggregate([
      { $match: { orgId, site_id: siteId, status: 'recorded' } },
      { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    ProgressUpdate.findOne({ orgId, site_id: siteId, status: 'recorded' }).sort({ as_of: -1, createdAt: -1, _id: -1 }).lean(),
  ]);
  return build(
    site, budget,
    payRows.map((r) => ({ category: r._id, total: r.total, count: r.count })),
    latest,
    { detail: true, now: Date.now() }
  );
}

/** Every site in the organisation, worst first, with counts by status. */
async function portfolio(orgIdValue) {
  const orgId = toObjectId(orgIdValue);
  const [sites, budgets, payRows, latestRows] = await Promise.all([
    Site.find({ orgId }, '_id name').lean(),
    SiteBudget.find({ orgId }).lean(),
    SitePayment.aggregate([
      { $match: { orgId, status: 'recorded' } },
      { $group: { _id: { site: '$site_id', category: '$category' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    ProgressUpdate.aggregate([
      { $match: { orgId, status: 'recorded' } },
      { $sort: { site_id: 1, as_of: -1, createdAt: -1, _id: -1 } },
      { $group: { _id: '$site_id', doc: { $first: '$$ROOT' } } },
    ]),
  ]);

  const budgetBySite = new Map(budgets.map((b) => [String(b.site_id), b]));
  const latestBySite = new Map(latestRows.map((r) => [String(r._id), r.doc]));
  const paidBySite = new Map();
  for (const r of payRows) {
    const key = String(r._id.site);
    if (!paidBySite.has(key)) paidBySite.set(key, []);
    paidBySite.get(key).push({ category: r._id.category, total: r.total, count: r.count });
  }

  const now = Date.now();
  const rows = sites.map((s) => build(
    s,
    budgetBySite.get(String(s._id)) || null,
    paidBySite.get(String(s._id)) || [],
    latestBySite.get(String(s._id)) || null,
    { detail: false, now }
  ));

  // The sites that need a look first: over budget, then running hot, then the
  // rest; within a status, the one furthest through its budget first.
  const rank = { over: 0, watch: 1, on_track: 2, early: 3, no_budget: 4 };
  rows.sort((a, b) =>
    (rank[a.assessment.status] - rank[b.assessment.status]) ||
    ((b.assessment.spent_percent ?? -1) - (a.assessment.spent_percent ?? -1)) ||
    a.site_name.localeCompare(b.site_name)
  );

  const counts = { over: 0, watch: 0, on_track: 0, early: 0, no_budget: 0 };
  for (const r of rows) counts[r.assessment.status] += 1;
  const budgeted = rows.filter((r) => r.budget);

  return {
    totals: {
      site_count: rows.length,
      budgeted_site_count: budgeted.length,
      budget_amount: round2(budgeted.reduce((sum, r) => sum + r.budget.amount, 0)),
      // Paid at budgeted sites only, so it can be read against the budget total.
      spent_on_budgeted: round2(budgeted.reduce((sum, r) => sum + r.spent.total, 0)),
      spent_amount: round2(rows.reduce((sum, r) => sum + r.spent.total, 0)),
      stale_progress_count: rows.filter((r) => r.progress?.stale).length,
      no_progress_count: rows.filter((r) => !r.progress).length,
      by_status: counts,
    },
    sites: rows,
  };
}

module.exports = {
  siteOverview, portfolio, assess, THRESHOLDS,
  PACE_TOLERANCE, MIN_PROGRESS_TO_PROJECT, STALE_AFTER_DAYS,
};
