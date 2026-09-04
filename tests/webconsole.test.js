const request = require('supertest');
const app = require('../server');
const Slip = require('../models/Slip');
const User = require('../models/User');
const Inventory = require('../models/Inventory');
const { createWorld, createManager, createSite, bearer } = require('./helpers/factories');

// Backend for the web console (WEB-APP-PLAN phases 1 and 4). Every field here is
// ADDITIVE: one API is about to have two clients, so nothing existing may change
// shape. The first test in each block is the one that guards that.

const day = (n) => new Date(Date.now() - n * 86400000);

async function slip(org, site, manager, { status = 'approved', qty = 10, cost = 50, at = day(1), decidedAt = null }) {
  return Slip.create({
    site_id: site._id, site_name: site.name,
    manager_id: manager._id, manager_name: manager.name,
    items: [{ material_name: 'Cement', quantity_taken: qty, unit: 'bags', unit_cost: cost, line_total: qty * cost }],
    total_value: qty * cost,
    status, orgId: org._id, createdAt: at, updatedAt: decidedAt || at,
    decided_at: status === 'pending' ? null : (decidedAt || at),
  });
}

describe('GET /api/users/managers?scope=all', () => {
  it('leaves the default response exactly as the Android app expects it', async () => {
    const { org, owner, site } = await createWorld();
    await createManager(org, site, { status: 'pending', name: 'Pending Pete' });

    const res = await request(app).get('/api/users/managers').set(bearer(owner.token));
    expect(res.status).toBe(200);
    // Approved only, and no new keys on the row.
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBeUndefined();
    expect(res.body.data[0].assigned).toBeUndefined();
  });

  it('adds pending and unassigned managers, with their status', async () => {
    const { org, owner, site } = await createWorld();
    await createManager(org, site, { status: 'pending', name: 'Pending Pete' });
    await createManager(org, null, { status: 'approved', name: 'Unassigned Uma', site_ids: [], site_name: '' });

    const res = await request(app).get('/api/users/managers?scope=all').set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);

    const byName = Object.fromEntries(res.body.data.map((m) => [m.name, m]));
    expect(byName['Pending Pete'].status).toBe('pending');
    expect(byName['Unassigned Uma'].assigned).toBe(false);
    expect(byName['Test Manager'].assigned).toBe(true);
  });

  it('still refuses a manager', async () => {
    const { manager } = await createWorld();
    expect((await request(app).get('/api/users/managers?scope=all').set(bearer(manager.token))).status).toBe(403);
  });
});

describe('GET /api/reports/analytics — the four web-console extensions', () => {
  const analytics = (token, q = '') => request(app).get(`/api/reports/analytics${q}`).set(bearer(token));

  it('still returns every field the app already reads', async () => {
    const { owner } = await createWorld();
    const res = await analytics(owner.token, '?days=30');
    expect(res.status).toBe(200);
    for (const key of ['kpis', 'inventory_health', 'value', 'stock_intelligence',
                       'consumption', 'procurement', 'accountability', 'slip_stats', 'site_comparison']) {
      expect(res.body.data[key]).toBeDefined();
    }
    expect(res.body.data.consumption.trend).toBeDefined(); // the quantity series is untouched
  });

  it('§6.1 — reports money moved per day per site, not just quantity', async () => {
    const { org, owner, site, manager } = await createWorld();
    const siteB = await createSite(org, 'Site B');
    await slip(org, site, manager.user, { qty: 10, cost: 50, at: day(2) });   // ₹500
    await slip(org, siteB, manager.user, { qty: 4, cost: 25, at: day(2) });   // ₹100

    const res = await analytics(owner.token, '?days=30');
    const trend = res.body.data.consumption.value_trend;
    expect(trend.length).toBe(2);
    expect(trend.reduce((s, r) => s + r.value, 0)).toBe(600);
    expect(trend.map((r) => r.site_name).sort()).toEqual(['Site A', 'Site B']);
  });

  it('§6.1 — says how many lines were priced, so a low total is not read as good news', async () => {
    const { org, owner, site, manager } = await createWorld();
    await slip(org, site, manager.user, { qty: 10, cost: null, at: day(1) });

    const row = (await analytics(owner.token, '?days=30')).body.data.consumption.value_trend[0];
    expect(row.total_lines).toBe(1);
    expect(row.priced_lines).toBe(0);
  });

  it('§6.3 — turns the one-scalar slip funnel into a weekly series', async () => {
    const { org, owner, site, manager } = await createWorld();
    await slip(org, site, manager.user, { status: 'approved', at: day(2), decidedAt: day(1) }); // 24h
    await slip(org, site, manager.user, { status: 'rejected', at: day(2), decidedAt: day(1) });
    await slip(org, site, manager.user, { status: 'pending', at: day(2) });

    const funnel = (await analytics(owner.token, '?days=30')).body.data.accountability.slip_funnel;
    expect(funnel.length).toBeGreaterThanOrEqual(1);
    const total = funnel.reduce((a, w) => ({
      raised: a.raised + w.raised, approved: a.approved + w.approved,
      rejected: a.rejected + w.rejected, pending: a.pending + w.pending,
    }), { raised: 0, approved: 0, rejected: 0, pending: 0 });
    expect(total).toEqual({ raised: 3, approved: 1, rejected: 1, pending: 1 });
    expect(funnel[0].week).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('§6.3 — leaves decision time null for a week that decided nothing', async () => {
    // Zero would draw a line claiming the owner answered instantly.
    const { org, owner, site, manager } = await createWorld();
    await slip(org, site, manager.user, { status: 'pending', at: day(2) });

    const funnel = (await analytics(owner.token, '?days=30')).body.data.accountability.slip_funnel;
    expect(funnel[0].pending).toBe(1);
    expect(funnel[0].avg_decision_hours).toBeNull();
  });

  it('§6.4 — puts rupees on site comparison alongside quantity', async () => {
    const { org, owner, site, manager } = await createWorld();
    await slip(org, site, manager.user, { qty: 8, cost: 125, at: day(1) }); // ₹1,000

    const cmp = (await analytics(owner.token, '?days=30')).body.data.site_comparison
      .find((s) => s.site_name === 'Site A');
    expect(cmp.quantity_consumed).toBe(8);
    expect(cmp.value_consumed).toBe(1000);
  });

  it('§6.4 — gives a site with stock but no slips a zero, not a missing field', async () => {
    const { org, owner } = await createWorld();
    const quiet = await createSite(org, 'Quiet Site');
    await Inventory.create({ name: 'Sand', quantity: 5, unit: 'tonnes', site_id: quiet._id,
      site_name: quiet.name, low_stock_threshold: 1, orgId: org._id });

    const cmp = (await analytics(owner.token, '?days=30')).body.data.site_comparison
      .find((s) => s.site_name === 'Quiet Site');
    expect(cmp.value_consumed).toBe(0);
  });

  it('§6.6 — prices idle stock, and totals it', async () => {
    const { org, owner, site } = await createWorld();
    await Inventory.create({ name: 'Steel', quantity: 20, unit: 'tonnes', unit_cost: 1000,
      site_id: site._id, site_name: site.name, low_stock_threshold: 1, orgId: org._id });

    const si = (await analytics(owner.token, '?days=30')).body.data.stock_intelligence;
    const steel = si.idle_stock.find((i) => i.material_name === 'Steel');
    expect(steel.value).toBe(20000);
    expect(si.idle_stock_value).toBeGreaterThanOrEqual(20000);
  });

  it('§6.6 — leaves unpriced idle stock null and counts it, rather than calling it worthless', async () => {
    const { org, owner, site } = await createWorld();
    await Inventory.create({ name: 'Gravel', quantity: 100, unit: 'tonnes', // no unit_cost
      site_id: site._id, site_name: site.name, low_stock_threshold: 1, orgId: org._id });

    const si = (await analytics(owner.token, '?days=30')).body.data.stock_intelligence;
    expect(si.idle_stock.find((i) => i.material_name === 'Gravel').value).toBeNull();
    expect(si.idle_stock_unpriced).toBeGreaterThanOrEqual(1);
  });

  it('does not leak another organisation into any new series', async () => {
    const a = await createWorld();
    const b = await createWorld();
    await slip(b.org, b.site, b.manager.user, { qty: 99, cost: 99, at: day(1) });

    const data = (await analytics(a.owner.token, '?days=30')).body.data;
    expect(data.consumption.value_trend.reduce((s, r) => s + r.value, 0)).toBe(0);
    expect(data.accountability.slip_funnel.reduce((s, w) => s + w.raised, 0)).toBe(0);
  });
});
