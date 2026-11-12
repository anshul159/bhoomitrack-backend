const express = require('express');
const router = express.Router();
// No `auth` here on purpose — applied at the mount in server.js (PF-007).
const { ownerOnly } = require('../middleware/roles');
const siteAccess = require('../middleware/siteAccess');
const SiteBudget = require('../models/SiteBudget');
const SitePayment = require('../models/SitePayment');
const audit = require('../utils/audit');
const { formatRupees } = require('../utils/money');
const { isDuplicateKeyError } = require('../utils/duplicateKey');
const { ValidationError, optionalText } = require('../utils/siteRecords');
const { siteOverview, portfolio, THRESHOLDS } = require('../utils/siteProgress');

// Site budgets (v2), and the comparison they exist for: budget against what has
// been paid at the site against how much of the work is done. Owner only, every
// route — a site manager records payments and progress but never sees the
// budget (models/SiteBudget.js).

// Far above any single site; it only catches a stray run of extra zeros.
const MAX_BUDGET = 10_000 * 1_00_00_000; // ₹10,000 crore

const round2 = (n) => Math.round(n * 100) / 100;
const labelOf = (category) => SitePayment.CATEGORY_LABELS[category] || category;

function parseAmount(value) {
  if (value === undefined || value === null || value === '') throw new ValidationError('Enter the budget for this site');
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError('The budget must be greater than 0');
  if (amount > MAX_BUDGET) throw new ValidationError('That budget looks too large. Check for an extra zero.');
  return round2(amount);
}

/**
 * The optional split by head. A head left empty or at 0 is no head at all. The
 * split may cover less than the total — the rest is unallocated — but never more.
 */
function parseHeads(value, total) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError('The split must be a list of heads');
  if (value.length > SitePayment.CATEGORIES.length) throw new ValidationError('Too many heads in the split');

  const seen = new Set();
  const heads = [];
  for (const head of value) {
    if (!head || typeof head !== 'object') throw new ValidationError('Each head needs a category and an amount');
    if (!SitePayment.CATEGORIES.includes(head.category)) {
      throw new ValidationError(`Budget heads must be one of ${SitePayment.CATEGORIES.join(', ')}`);
    }
    if (seen.has(head.category)) throw new ValidationError(`${labelOf(head.category)} appears twice in the split`);
    seen.add(head.category);
    if (head.amount === undefined || head.amount === null || head.amount === '') continue;
    const amount = Number(head.amount);
    if (!Number.isFinite(amount) || amount < 0) throw new ValidationError(`${labelOf(head.category)} must be an amount`);
    if (amount === 0) continue;
    heads.push({ category: head.category, amount: round2(amount) });
  }

  const allocated = round2(heads.reduce((sum, h) => sum + h.amount, 0));
  if (allocated > total) {
    throw new ValidationError(
      `The heads add up to ${formatRupees(allocated)}, more than the total budget of ${formatRupees(total)}`
    );
  }
  return heads.sort((a, b) => SitePayment.CATEGORIES.indexOf(a.category) - SitePayment.CATEGORIES.indexOf(b.category));
}

/** The revision the client was editing, when it says. Absent means "whatever is current". */
function parseRevision(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new ValidationError('Invalid budget revision');
  return n;
}

// The figures only. A note explains a change in the figures; on its own it is
// not a revision — otherwise opening the form and saving it untouched (the note
// field starts empty on a revision) would write a revision that changed nothing.
const sameFigures = (budget, amount, heads) =>
  budget.amount === amount &&
  JSON.stringify((budget.heads || []).map((h) => [h.category, h.amount])) ===
    JSON.stringify(heads.map((h) => [h.category, h.amount]));

const conflict = (res) => res.status(409).json({
  success: false,
  message: 'Someone else changed this budget just now. Reload to see it, then make your change again.',
});

// ─── GET /api/budgets ─────────────────────────────────────────────────────────
// Every site: budget, paid so far, latest progress and where each stands, worst
// first. Sites without a budget are listed too — that is itself worth seeing.
router.get('/', ownerOnly, async (req, res) => {
  try {
    const data = await portfolio(req.user.orgId);
    return res.json({ success: true, message: 'OK', data, thresholds: THRESHOLDS });
  } catch (err) {
    console.error('[BUDGET PORTFOLIO]', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/budgets/:site ───────────────────────────────────────────────────
// One site, with the budget's revision history. `budget` is null until set.
router.get('/:site', ownerOnly, siteAccess, async (req, res) => {
  try {
    const data = await siteOverview(req.user.orgId, req.site);
    return res.json({ success: true, message: 'OK', data, thresholds: THRESHOLDS });
  } catch (err) {
    console.error('[BUDGET GET]', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/budgets/:site ───────────────────────────────────────────────────
// Sets the budget, or revises it. Body: { amount, heads?: [{category, amount}],
// note?, revision? }. Answers with the whole overview, so the screen redraws
// from one round trip.
router.put('/:site', ownerOnly, siteAccess, async (req, res) => {
  try {
    const body = req.body || {};
    const amount = parseAmount(body.amount);
    const heads = parseHeads(body.heads, amount);
    const note = optionalText(body.note, 300, 'Note');
    const expected = parseRevision(body.revision);
    const site = req.site;
    const now = new Date();

    const current = await SiteBudget.findOne({ orgId: req.user.orgId, site_id: site._id }).lean();

    if (!current) {
      let created;
      try {
        created = await SiteBudget.create({
          orgId: req.user.orgId,
          site_id: site._id,
          amount,
          heads,
          note,
          original_amount: amount,
          revision: 1,
          set_by: req.user.id,
          set_by_name: req.user.name || '',
          set_at: now,
        });
      } catch (err) {
        // Two owners setting a first budget at the same moment: one wins.
        if (isDuplicateKeyError(err)) return conflict(res);
        throw err;
      }
      audit.record(req, {
        action: 'budget.set',
        entity: 'budget',
        entity_id: created._id,
        entity_label: `${formatRupees(amount)} for ${site.name}`,
        site_id: site._id,
        site_name: site.name,
        after: { amount, heads: heads.length },
        note: note || undefined,
      });
    } else if (sameFigures(current, amount, heads)) {
      // Nothing changed — a second tap, or a retry of a save that landed. Not a
      // revision, and never a conflict, whatever revision the client sent.
      const data = await siteOverview(req.user.orgId, site);
      return res.json({ success: true, message: 'Budget unchanged', data, thresholds: THRESHOLDS, unchanged: true });
    } else {
      if (expected !== null && expected !== current.revision) return conflict(res);
      const updated = await SiteBudget.findOneAndUpdate(
        { _id: current._id, revision: current.revision },
        {
          $set: { amount, heads, note, set_by: req.user.id, set_by_name: req.user.name || '', set_at: now },
          $inc: { revision: 1 },
          $push: {
            history: {
              $each: [{
                amount: current.amount,
                heads: current.heads || [],
                note: current.note || '',
                revision: current.revision,
                set_by_name: current.set_by_name || '',
                set_at: current.set_at,
              }],
              $slice: -SiteBudget.HISTORY_LIMIT,
            },
          },
        },
        { new: true }
      );
      // Revised by someone else between the read and this write.
      if (!updated) return conflict(res);
      audit.record(req, {
        action: 'budget.revise',
        entity: 'budget',
        entity_id: updated._id,
        entity_label: `${formatRupees(current.amount)} → ${formatRupees(amount)} for ${site.name}`,
        site_id: site._id,
        site_name: site.name,
        before: { amount: current.amount, heads: (current.heads || []).length },
        after: { amount, heads: heads.length },
        note: note || undefined,
      });
    }

    const data = await siteOverview(req.user.orgId, site);
    return res.json({ success: true, message: current ? 'Budget revised' : 'Budget set', data, thresholds: THRESHOLDS });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ success: false, message: err.message });
    console.error('[BUDGET SET]', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
