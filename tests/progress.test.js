const request = require('supertest');
const app = require('../server');
const ProgressUpdate = require('../models/ProgressUpdate');
const SiteBudget = require('../models/SiteBudget');
const SitePayment = require('../models/SitePayment');
const Attachment = require('../models/Attachment');
const AuditLog = require('../models/AuditLog');
const { assess } = require('../utils/siteProgress');
const { createWorld, createSite, createManager, bearer } = require('./helpers/factories');

// v2 budget and progress (the Manas conversation, 2026-11-10): a site engineer
// reports how much of the work is done every few days; an owner sets what the
// site should cost; the owner sees money paid against work done. Progress is a
// record like a payment — no approval, voided by an owner, never deleted. The
// budget is the owner's alone: a manager can neither see nor set it.

const DAY = 24 * 60 * 60 * 1000;

function jpegBytes(size = 2048) {
  const b = Buffer.alloc(size, 7);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  for (let i = 4; i < size; i++) b[i] = (i * 31) % 256;
  return b;
}
const asDataUri = (buf, type = 'image/jpeg') => `data:${type};base64,${buf.toString('base64')}`;
const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
// Audit rows are written after the response has gone; wait for them.
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) return;
    await new Promise((r) => setTimeout(r, 10));
  }
};

const postProgress = (token, body) => request(app).post('/api/progress').set(bearer(token)).send(body);
const putBudget = (token, site, body) => request(app).put(`/api/budgets/${encodeURIComponent(site)}`).set(bearer(token)).send(body);
const getBudget = (token, site) => request(app).get(`/api/budgets/${encodeURIComponent(site)}`).set(bearer(token));
const pay = (token, amount, extra = {}) => request(app).post('/api/payments').set(bearer(token))
  .send({ category: 'labour', amount, paid_to: 'Mason gang', ...extra });

describe('progress updates (v2)', () => {
  it('lets a manager report progress on their own site, with a photo of the work', async () => {
    const { site, manager } = await createWorld();
    const photo = jpegBytes();

    const res = await postProgress(manager.token, { percent: 35, work_done: 'Ground-floor slab cast', photo_image: asDataUri(photo) });

    expect(res.status).toBe(200);
    const p = res.body.data;
    expect(p.site_name).toBe(site.name);
    expect(p.percent).toBe(35);
    expect(p.work_done).toBe('Ground-floor slab cast');
    expect(p.has_photo).toBe(true);
    expect(p.recorded_by_name).toBe('Test Manager');
    expect(p.status).toBe('recorded');
    expect(res.body.previous_percent).toBeNull();

    const img = await request(app).get(`/api/attachments/${p.photo_attachment_id}`)
      .set(bearer(manager.token)).buffer(true).parse(binaryParser);
    expect(img.status).toBe(200);
    expect(Buffer.compare(img.body, photo)).toBe(0);
    expect((await Attachment.findById(p.photo_attachment_id).lean()).kind).toBe('progress');

    // The next one says what it was before.
    const next = await postProgress(manager.token, { percent: 42 });
    expect(next.body.previous_percent).toBe(35);
  });

  it('needs only the percentage, and keeps one decimal place', async () => {
    const { manager } = await createWorld();
    const res = await postProgress(manager.token, { percent: '47.26' });
    expect(res.status).toBe(200);
    expect(res.body.data.percent).toBe(47.3);
    expect(res.body.data.work_done).toBe('');
    expect(res.body.data.has_photo).toBe(false);
  });

  it.each([
    [{}, 'Enter how much'],
    [{ percent: '' }, 'Enter how much'],
    [{ percent: 'half' }, 'number'],
    [{ percent: -1 }, 'between 0 and 100'],
    [{ percent: 100.5 }, 'between 0 and 100'],
    [{ percent: 40, work_done: 'x'.repeat(501) }, '500 characters'],
    [{ percent: 40, as_of: new Date(Date.now() + 3 * DAY).toISOString() }, 'future'],
    [{ percent: 40, photo_image: asDataUri(Buffer.from('<svg/>'), 'image/svg+xml') }, 'The photo must be'],
    [{ percent: 40, photo_image: asDataUri(Buffer.from('not really a jpeg at all')) }, 'The photo is not a valid image'],
  ])('refuses %j', async (body, message) => {
    const { manager } = await createWorld();
    const res = await postProgress(manager.token, body);
    expect(res.status).toBe(400);
    expect(res.body.message).toContain(message);
    expect(await ProgressUpdate.countDocuments()).toBe(0);
    expect(await Attachment.countDocuments()).toBe(0);
  });

  it('accepts 0% and 100%', async () => {
    const { manager } = await createWorld();
    expect((await postProgress(manager.token, { percent: 0 })).status).toBe(200);
    expect((await postProgress(manager.token, { percent: 100 })).status).toBe(200);
  });

  it('pins a manager to their own site, and lets an owner report for any site', async () => {
    const { org, owner, manager } = await createWorld();
    const other = await createSite(org, 'Site B');

    const refused = await postProgress(manager.token, { site_name: 'Site B', percent: 20 });
    expect(refused.status).toBe(403);

    const unassigned = await createManager(org, null);
    expect((await postProgress(unassigned.token, { percent: 20 })).status).toBe(400);

    const byOwner = await postProgress(owner.token, { site_name: 'Site B', percent: 20 });
    expect(byOwner.status).toBe(200);
    expect(byOwner.body.data.site_id).toBe(String(other._id));
    expect(byOwner.body.data.recorded_by_role).toBe('owner');

    // An owner must say which site.
    expect((await postProgress(owner.token, { percent: 20 })).status).toBe(404);
  });

  it('keeps one update and one photo when the same submission is retried', async () => {
    const { manager } = await createWorld();
    const body = { percent: 50, photo_image: asDataUri(jpegBytes()), client_request_id: 'retry-progress-1' };

    const first = await postProgress(manager.token, body);
    const second = await postProgress(manager.token, body);

    expect(second.status).toBe(200);
    expect(second.body.idempotent_replay).toBe(true);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await ProgressUpdate.countDocuments()).toBe(1);
    expect(await Attachment.countDocuments()).toBe(1);
  });

  it('lists newest first by the day assessed, and the latest is the newest recorded one', async () => {
    const { owner, manager } = await createWorld();
    await postProgress(manager.token, { percent: 30, as_of: new Date(Date.now() - 6 * DAY).toISOString() });
    const latest = await postProgress(manager.token, { percent: 45 });
    // Entered last, but assessed four days ago: it sorts between the two.
    await postProgress(manager.token, { percent: 38, as_of: new Date(Date.now() - 4 * DAY).toISOString() });

    const res = await request(app).get('/api/progress/Site A').set(bearer(manager.token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((p) => p.percent)).toEqual([45, 38, 30]);
    expect(res.body.latest.id).toBe(latest.body.data.id);
    expect(res.body.stale_after_days).toBe(7);
    expect(res.body.page.total).toBe(3);

    // Voiding the latest makes the one before it current — and it stays in the list.
    const voided = await request(app).put(`/api/progress/void/${latest.body.data.id}`).set(bearer(owner.token))
      .send({ reason: 'Counted the second floor twice' });
    expect(voided.status).toBe(200);
    expect(voided.body.message).toBe('Progress update voided');

    const after = await request(app).get('/api/progress/Site A').set(bearer(owner.token));
    expect(after.body.latest.percent).toBe(38);
    expect(after.body.data).toHaveLength(3);
    expect(after.body.data[0].status).toBe('void');
    expect(after.body.data[0].void_reason).toBe('Counted the second floor twice');
  });

  it('lets only an owner void, only with a reason, and only once — and audits it', async () => {
    const { owner, manager } = await createWorld();
    const created = await postProgress(manager.token, { percent: 60 });
    const id = created.body.data.id;

    expect((await request(app).put(`/api/progress/void/${id}`).set(bearer(manager.token)).send({ reason: 'mine' })).status).toBe(403);
    expect((await request(app).put(`/api/progress/void/${id}`).set(bearer(owner.token)).send({})).status).toBe(400);
    expect((await request(app).put(`/api/progress/void/${id}`).set(bearer(owner.token)).send({ reason: 'Too high' })).status).toBe(200);
    const again = await request(app).put(`/api/progress/void/${id}`).set(bearer(owner.token)).send({ reason: 'Again' });
    expect(again.status).toBe(400);
    expect(again.body.message).toBe('This progress update is already void');

    expect(await ProgressUpdate.countDocuments({ _id: id })).toBe(1);
    await until(async () => (await AuditLog.countDocuments({ entity_id: id })) >= 2);
    const actions = (await AuditLog.find({ entity_id: id }).lean()).map((a) => a.action).sort();
    expect(actions).toEqual(['progress.record', 'progress.void']);
  });

  it('keeps managers to their own site and organisations to themselves', async () => {
    const a = await createWorld();
    const b = await createWorld();
    const otherSite = await createSite(a.org, 'Site B');
    const otherManager = await createManager(a.org, otherSite);
    const created = await postProgress(a.manager.token, { percent: 20, photo_image: asDataUri(jpegBytes()) });
    const { id, photo_attachment_id: photoId } = created.body.data;

    expect((await request(app).get('/api/progress/Site A').set(bearer(otherManager.token))).status).toBe(403);
    expect((await request(app).get(`/api/attachments/${photoId}`).set(bearer(otherManager.token))).status).toBe(403);

    // Both orgs have a "Site A"; b sees only its own, which has nothing.
    const list = await request(app).get('/api/progress/Site A').set(bearer(b.owner.token));
    expect(list.body.data).toHaveLength(0);
    expect(list.body.latest).toBeNull();
    expect((await request(app).get(`/api/attachments/${photoId}`).set(bearer(b.owner.token))).status).toBe(404);
    expect((await request(app).put(`/api/progress/void/${id}`).set(bearer(b.owner.token)).send({ reason: 'not yours' })).status).toBe(404);
  });
});

describe('site budgets (v2)', () => {
  it('is the owner’s alone: a manager can neither read nor set one', async () => {
    const { manager } = await createWorld();
    expect((await request(app).get('/api/budgets').set(bearer(manager.token))).status).toBe(403);
    expect((await getBudget(manager.token, 'Site A')).status).toBe(403);
    expect((await putBudget(manager.token, 'Site A', { amount: 500000 })).status).toBe(403);
    expect(await SiteBudget.countDocuments()).toBe(0);
  });

  it('starts with no budget, and compares once one is set', async () => {
    const { owner, manager } = await createWorld();
    await pay(manager.token, 150000);

    const before = await getBudget(owner.token, 'Site A');
    expect(before.status).toBe(200);
    expect(before.body.data.budget).toBeNull();
    expect(before.body.data.spent.total).toBe(150000);
    expect(before.body.data.assessment.status).toBe('no_budget');
    expect(before.body.thresholds).toEqual({ pace_tolerance_percent: 10, min_progress_to_project: 10, stale_after_days: 7 });

    const set = await putBudget(owner.token, 'Site A', { amount: 1000000, note: 'Two floors, client estimate' });
    expect(set.status).toBe(200);
    expect(set.body.message).toBe('Budget set');
    const { budget, assessment } = set.body.data;
    expect(budget).toMatchObject({ amount: 1000000, original_amount: 1000000, revision: 1, note: 'Two floors, client estimate', set_by_name: 'Test Owner' });
    expect(budget.history).toEqual([]);
    expect(assessment).toMatchObject({ status: 'early', spent_percent: 15, remaining: 850000, projected_cost: null });
  });

  it('projects the final cost from money paid and work done', async () => {
    const { owner, manager } = await createWorld();
    await putBudget(owner.token, 'Site A', { amount: 1000000 });
    await pay(manager.token, 200000);
    await postProgress(manager.token, { percent: 25 });

    const onTrack = (await getBudget(owner.token, 'Site A')).body.data;
    expect(onTrack.progress).toMatchObject({ percent: 25, stale: false, days_since: 0 });
    expect(onTrack.assessment).toMatchObject({
      status: 'on_track', spent_percent: 20, projected_cost: 800000, projected_over: -200000, projected_over_percent: -20,
    });
    expect(onTrack.assessment.method).toMatch(/paid so far ÷ work done/);

    // ₹5 lakh paid for 40% of the work: ₹12.5 lakh at this rate, 25% over.
    await pay(manager.token, 300000);
    await postProgress(manager.token, { percent: 40 });
    const watch = (await getBudget(owner.token, 'Site A')).body.data.assessment;
    expect(watch).toMatchObject({ status: 'watch', projected_cost: 1250000, projected_over_percent: 25 });

    // More paid than the whole budget.
    await pay(manager.token, 600000);
    expect((await getBudget(owner.token, 'Site A')).body.data.assessment).toMatchObject({ status: 'over', remaining: -100000 });
  });

  it('leaves void payments and void progress out of the comparison', async () => {
    const { owner, manager } = await createWorld();
    await putBudget(owner.token, 'Site A', { amount: 1000000 });
    await pay(manager.token, 200000);
    const wrong = await pay(manager.token, 900000);
    await postProgress(manager.token, { percent: 25 });
    const tooHigh = await postProgress(manager.token, { percent: 90 });

    await request(app).put(`/api/payments/void/${wrong.body.data.id}`).set(bearer(owner.token)).send({ reason: 'Extra zero' });
    await request(app).put(`/api/progress/void/${tooHigh.body.data.id}`).set(bearer(owner.token)).send({ reason: 'Typo' });

    const data = (await getBudget(owner.token, 'Site A')).body.data;
    expect(data.spent).toMatchObject({ total: 200000, count: 1 });
    expect(data.progress.percent).toBe(25);
    expect(data.assessment.status).toBe('on_track');
  });

  it('splits by head, compares each head with its payments, and refuses a split above the total', async () => {
    const { owner, manager } = await createWorld();
    const res = await putBudget(owner.token, 'Site A', {
      amount: 1000000,
      heads: [
        { category: 'material', amount: 550000 },
        { category: 'labour', amount: 300000 },
        { category: 'equipment', amount: 0 },   // an empty head is no head
        { category: 'salary', amount: '' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.budget.heads).toEqual([
      { category: 'labour', amount: 300000 },
      { category: 'material', amount: 550000 },
    ]);
    expect(res.body.data.budget).toMatchObject({ allocated: 850000, unallocated: 150000 });

    await pay(manager.token, 320000);                                   // labour, over its head
    await pay(manager.token, 40000, { category: 'equipment' });          // no head for it
    const lines = (await getBudget(owner.token, 'Site A')).body.data.spent.by_category;
    expect(lines).toEqual([
      { category: 'labour', total: 320000, count: 1, budget: 300000, over: true, pace: 'over' },
      { category: 'material', total: 0, count: 0, budget: 550000, over: false, pace: 'ok' },
      { category: 'equipment', total: 40000, count: 1, budget: null, over: false, pace: null },
    ]);

    const tooMuch = await putBudget(owner.token, 'Site A', {
      amount: 500000, heads: [{ category: 'material', amount: 400000 }, { category: 'labour', amount: 200000 }],
    });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.message).toContain('more than the total budget');

    expect((await putBudget(owner.token, 'Site A', { amount: 500000, heads: [{ category: 'cement', amount: 1 }] })).status).toBe(400);
    expect((await putBudget(owner.token, 'Site A', {
      amount: 500000, heads: [{ category: 'labour', amount: 1 }, { category: 'labour', amount: 2 }],
    })).body.message).toContain('appears twice');
  });

  it('says which head is running ahead of the work, by the same 10% rule as the site', async () => {
    const { owner, manager } = await createWorld();
    await putBudget(owner.token, 'Site A', {
      amount: 1000000,
      heads: [{ category: 'labour', amount: 400000 }, { category: 'material', amount: 500000 }],
    });
    await pay(manager.token, 240000);                                   // labour: 60% of its head
    await pay(manager.token, 200000, { category: 'material' });         // material: 40% of its head

    // Before 10% is done, too early to say any head is ahead.
    await postProgress(manager.token, { percent: 8 });
    let lines = (await getBudget(owner.token, 'Site A')).body.data.spent.by_category;
    expect(lines.map((l) => [l.category, l.pace])).toEqual([['labour', 'ok'], ['material', 'ok']]);

    // At 45% done: labour's 60% is past 45% + 10%; material's 40% is not.
    await postProgress(manager.token, { percent: 45 });
    lines = (await getBudget(owner.token, 'Site A')).body.data.spent.by_category;
    expect(lines.map((l) => [l.category, l.pace])).toEqual([['labour', 'ahead'], ['material', 'ok']]);
  });

  it.each([
    [{}, 'Enter the budget'],
    [{ amount: 0 }, 'greater than 0'],
    [{ amount: -5 }, 'greater than 0'],
    [{ amount: 'lots' }, 'greater than 0'],
    [{ amount: 2e11 }, 'too large'],
    [{ amount: 1000, heads: 'all labour' }, 'list'],
    [{ amount: 1000, note: 'n'.repeat(301) }, '300 characters'],
  ])('refuses %j', async (body, message) => {
    const { owner } = await createWorld();
    const res = await putBudget(owner.token, 'Site A', body);
    expect(res.status).toBe(400);
    expect(res.body.message).toContain(message);
  });

  it('keeps the earlier figures when a budget is revised, and the first one throughout', async () => {
    const { owner } = await createWorld();
    await putBudget(owner.token, 'Site A', { amount: 5000000, heads: [{ category: 'material', amount: 3000000 }] });
    const second = await putBudget(owner.token, 'Site A', { amount: 5500000, note: 'Client added a floor', revision: 1 });
    expect(second.status).toBe(200);
    expect(second.body.message).toBe('Budget revised');
    await putBudget(owner.token, 'Site A', { amount: 5400000, revision: 2 });

    const { budget } = (await getBudget(owner.token, 'Site A')).body.data;
    expect(budget).toMatchObject({ amount: 5400000, original_amount: 5000000, revision: 3, heads: [] });
    expect(budget.history.map((h) => [h.revision, h.amount])).toEqual([[2, 5500000], [1, 5000000]]);
    expect(budget.history[0].note).toBe('Client added a floor');
    expect(budget.history[1].heads).toEqual([{ category: 'material', amount: 3000000 }]);

    await until(async () => (await AuditLog.countDocuments({ entity: 'budget' })) >= 3);
    const actions = (await AuditLog.find({ entity: 'budget' }).lean()).map((a) => a.action).sort();
    expect(actions).toEqual(['budget.revise', 'budget.revise', 'budget.set']);
  });

  it('refuses an edit made against a revision someone else has since replaced', async () => {
    const { owner } = await createWorld();
    await putBudget(owner.token, 'Site A', { amount: 1000000 });
    await putBudget(owner.token, 'Site A', { amount: 1100000, revision: 1 });     // another owner, first

    const stale = await putBudget(owner.token, 'Site A', { amount: 1200000, revision: 1 });
    expect(stale.status).toBe(409);
    expect((await SiteBudget.findOne().lean()).amount).toBe(1100000);

    // Without a revision it is simply the newest change.
    expect((await putBudget(owner.token, 'Site A', { amount: 1200000 })).status).toBe(200);
  });

  it('treats the same figures again as no change — even from a stale revision, as a retry would be', async () => {
    const { owner } = await createWorld();
    await putBudget(owner.token, 'Site A', { amount: 1000000, heads: [{ category: 'labour', amount: 400000 }] });
    await putBudget(owner.token, 'Site A', { amount: 1100000, heads: [{ category: 'labour', amount: 400000 }], revision: 1 });

    const retry = await putBudget(owner.token, 'Site A', { amount: 1100000, heads: [{ category: 'labour', amount: 400000 }], revision: 1 });
    expect(retry.status).toBe(200);
    expect(retry.body.unchanged).toBe(true);
    expect(retry.body.data.budget.revision).toBe(2);
    expect((await SiteBudget.findOne().lean()).history).toHaveLength(1);

    // A note on its own is not a revision: the form opens a revision with the note
    // empty, and saving it untouched must change nothing.
    const noteOnly = await putBudget(owner.token, 'Site A', { amount: 1100000, heads: [{ category: 'labour', amount: 400000 }], note: '' });
    expect(noteOnly.body.unchanged).toBe(true);
    expect((await SiteBudget.findOne().lean())).toMatchObject({ revision: 2 });
  });

  it('keeps one organisation out of another’s budgets', async () => {
    const a = await createWorld();
    const b = await createWorld();
    await putBudget(a.owner.token, 'Site A', { amount: 1000000 });

    // b's "Site A" is its own site, with no budget.
    expect((await getBudget(b.owner.token, 'Site A')).body.data.budget).toBeNull();
    expect((await getBudget(b.owner.token, String(a.site._id))).status).toBe(404);
    expect((await request(app).get('/api/budgets').set(bearer(b.owner.token))).body.data.totals.budgeted_site_count).toBe(0);
  });
});

describe('every site’s budget and progress (v2)', () => {
  it('lists every site worst first, with counts by status', async () => {
    const { org, owner, manager } = await createWorld();     // Site A
    await createSite(org, 'Site B');
    await createSite(org, 'Site C');
    const siteD = await createSite(org, 'Site D');

    // A: over budget. B: running hot. C: on track. D: no budget at all.
    await putBudget(owner.token, 'Site A', { amount: 100000 });
    await pay(manager.token, 120000);

    await putBudget(owner.token, 'Site B', { amount: 1000000 });
    await pay(owner.token, 600000, { site_name: 'Site B' });
    await postProgress(owner.token, { site_name: 'Site B', percent: 40 });

    await putBudget(owner.token, 'Site C', { amount: 1000000 });
    await pay(owner.token, 300000, { site_name: 'Site C' });
    // Progress last reported ten days ago: stale.
    await postProgress(owner.token, { site_name: 'Site C', percent: 30, as_of: new Date(Date.now() - 10 * DAY).toISOString() });

    const res = await request(app).get('/api/budgets').set(bearer(owner.token));
    expect(res.status).toBe(200);
    const { totals, sites } = res.body.data;
    expect(sites.map((s) => [s.site_name, s.assessment.status])).toEqual([
      ['Site A', 'over'], ['Site B', 'watch'], ['Site C', 'on_track'], ['Site D', 'no_budget'],
    ]);
    expect(sites[2].progress).toMatchObject({ percent: 30, stale: true, days_since: 10 });
    expect(sites[3].site_id).toBe(String(siteD._id));
    expect(sites[0]).not.toHaveProperty('budget.history');
    expect(totals).toEqual({
      site_count: 4,
      budgeted_site_count: 3,
      budget_amount: 2100000,
      spent_on_budgeted: 1020000,
      spent_amount: 1020000,
      stale_progress_count: 1,
      no_progress_count: 2,
      by_status: { over: 1, watch: 1, on_track: 1, early: 0, no_budget: 1 },
    });
  });
});

describe('the assessment rules', () => {
  it.each([
    // budget, paid, percent → status, projected
    [null, 50000, 40, 'no_budget', null],
    [1000000, 0, 40, 'early', null],                 // nothing paid: no projection
    [1000000, 50000, null, 'early', null],           // no progress reported yet
    [1000000, 50000, 9.9, 'early', null],            // under 10% done: too early
    [1000000, 100000, 10, 'on_track', 1000000],
    [1000000, 550000, 50, 'on_track', 1100000],      // exactly 10% over: still inside the band
    [1000000, 560000, 50, 'watch', 1120000],
    [1000000, 1000000, 100, 'on_track', 1000000],    // finished on budget
    [1000000, 1000001, 100, 'over', 1000001],
  ])('budget %p, paid %p, %p%% done → %s', (budget, spent, percent, status, projected) => {
    const result = assess(budget, spent, percent);
    expect(result.status).toBe(status);
    expect(result.projected_cost).toBe(projected);
  });
});

describe('budget and progress across the organisation (v2)', () => {
  const readExport = (token) => request(app).get('/api/org/export').set(bearer(token)).buffer(true)
    .parse((r, cb) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => cb(null, d)); });

  it('exports progress updates, their photos, and budgets with their history', async () => {
    const { owner, manager } = await createWorld();
    await postProgress(manager.token, { percent: 20, photo_image: asDataUri(jpegBytes()) });
    await putBudget(owner.token, 'Site A', { amount: 1000000 });
    await putBudget(owner.token, 'Site A', { amount: 1200000 });

    const body = JSON.parse((await readExport(owner.token)).body);
    expect(body.progress).toHaveLength(1);
    expect(body.budgets).toHaveLength(1);
    expect(body.budgets[0].history).toHaveLength(1);
    expect(body.attachments).toHaveLength(1);
    expect(body.counts).toMatchObject({ progress: 1, budgets: 1, attachments: 1 });
  });

  it('deletes them with the organisation', async () => {
    const { org, owner, manager } = await createWorld();
    await postProgress(manager.token, { percent: 20, photo_image: asDataUri(jpegBytes()) });
    await putBudget(owner.token, 'Site A', { amount: 1000000 });

    const res = await request(app).delete('/api/org').set(bearer(owner.token)).send({ confirmName: org.name });
    expect(res.status).toBe(200);
    expect(await ProgressUpdate.countDocuments({ orgId: org._id })).toBe(0);
    expect(await SiteBudget.countDocuments({ orgId: org._id })).toBe(0);
    expect(await Attachment.countDocuments({ orgId: org._id })).toBe(0);
  });

  it('carries a new site name onto progress updates, and the budget follows the site', async () => {
    const { site, owner, manager } = await createWorld();
    await postProgress(manager.token, { percent: 20 });
    await putBudget(owner.token, 'Site A', { amount: 1000000 });

    await request(app).put(`/api/sites/rename/${site._id}`).set(bearer(owner.token)).send({ name: 'Tower 2' });

    expect((await ProgressUpdate.findOne().lean()).site_name).toBe('Tower 2');
    const data = (await getBudget(owner.token, 'Tower 2')).body.data;
    expect(data.site_name).toBe('Tower 2');
    expect(data.budget.amount).toBe(1000000);
    expect(data.progress.percent).toBe(20);
  });
});

describe('payment heads for budgeting (v2)', () => {
  it('records equipment and staff-salary payments', async () => {
    const { manager } = await createWorld();
    expect((await pay(manager.token, 12000, { category: 'equipment', paid_to: 'JCB hire' })).status).toBe(200);
    expect((await pay(manager.token, 25000, { category: 'salary', paid_to: 'Site supervisor' })).status).toBe(200);
    expect(await SitePayment.countDocuments({ category: { $in: ['equipment', 'salary'] } })).toBe(2);
  });
});
