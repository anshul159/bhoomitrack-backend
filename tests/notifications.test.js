const request = require('supertest');
const app = require('../server');
const User = require('../models/User');
const Organization = require('../models/Organization');
const push = require('../utils/push');
const { sendDailySummaries, summaryMessage, indiaClock } = require('../utils/dailySummary');
const { formatRupees } = require('../utils/money');
const { createWorld, createOwner, createSite, bearer } = require('./helpers/factories');

// v2 owner notifications: the daily summary and the large-payment alert. Both
// are off until an owner turns them on, both go only to owners, and neither may
// ever be sent twice for the same thing.

const settings = (token) => request(app).get('/api/users/me/notifications').set(bearer(token));
const change = (token, body) => request(app).put('/api/users/me/notifications').set(bearer(token)).send(body);
const pay = (token, body) => request(app).post('/api/payments').set(bearer(token))
  .send({ category: 'material', amount: 100, paid_to: 'Shree Sand Suppliers', ...body });
const arrive = (token, body) => request(app).post('/api/arrivals').set(bearer(token))
  .send({ material_name: 'Sand', vehicle_type: 'tipper', vehicle_number: 'KA01', length: 10, breadth: 6, height: 2, dimension_unit: 'ft', ...body });
// Alerts and audit rows are written after the response has gone. Wait for what
// is expected rather than for a fixed time: a fixed 60 ms wait failed once on a
// busy machine. Where nothing should happen, wait long enough that a stray send
// would have landed.
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) return;
    await new Promise((r) => setTimeout(r, 10));
  }
};
const quietPeriod = () => new Promise((r) => setTimeout(r, 300));

describe('notification settings (v2)', () => {
  it('start with both notifications off, at 8 PM and ₹10,000', async () => {
    const { owner } = await createWorld();
    const res = await settings(owner.token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      daily_summary: false, daily_summary_hour: 20,
      large_payment_alert: false, large_payment_threshold: 10000,
      timezone: 'Asia/Kolkata',
    });
  });

  it('change only what is sent', async () => {
    const { owner } = await createWorld();
    await change(owner.token, { daily_summary: true });
    const res = await change(owner.token, { daily_summary_hour: 19, large_payment_alert: true, large_payment_threshold: 25000.5 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      daily_summary: true, daily_summary_hour: 19, large_payment_alert: true, large_payment_threshold: 25000.5,
    });
    expect((await settings(owner.token)).body.data.daily_summary).toBe(true);
  });

  it.each([
    [{ daily_summary: 'yes' }, /true or false/],
    [{ daily_summary_hour: 24 }, /0 to 23/],
    [{ daily_summary_hour: 19.5 }, /0 to 23/],
    [{ large_payment_threshold: 0 }, /more than ₹0/],
    [{ large_payment_threshold: '5000' }, /more than ₹0/],
  ])('refuse %j and save nothing else sent with it', async (body, message) => {
    const { owner } = await createWorld();
    const res = await change(owner.token, { daily_summary: true, ...body });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
    expect((await settings(owner.token)).body.data.daily_summary).toBe(false);
  });

  it('refuse an empty change', async () => {
    const { owner } = await createWorld();
    const res = await change(owner.token, {});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Nothing to change/);
  });

  it('are for owners only', async () => {
    const { manager } = await createWorld();
    expect((await settings(manager.token)).status).toBe(403);
    expect((await change(manager.token, { daily_summary: true })).status).toBe(403);
  });
});

describe('large-payment alert (v2)', () => {
  let sent;
  beforeEach(() => {
    sent = [];
    jest.spyOn(push, 'sendToUsers').mockImplementation(async (users, title, body, data) => {
      sent.push({ to: users.map((u) => String(u._id)), title, body, data });
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('tells each owner whose amount the payment reaches, and nobody else', async () => {
    const { org, owner, manager } = await createWorld();                  // owner: not opted in
    const low = await createOwner(org, { name: 'Low Threshold' });
    const high = await createOwner(org, { name: 'High Threshold' });
    await change(low.token, { large_payment_alert: true, large_payment_threshold: 5000 });
    await change(high.token, { large_payment_alert: true, large_payment_threshold: 50000 });

    await pay(manager.token, { amount: 12000 });
    await until(() => sent.length >= 1);
    await quietPeriod();

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([String(low.user._id)]);
    expect(sent[0].title).toBe('₹12,000 paid at Site A');
    expect(sent[0].body).toBe('To Shree Sand Suppliers · Material · recorded by Test Manager');
    expect(sent[0].data.type).toBe('large_payment');
    expect(String(owner.user._id)).not.toBe(sent[0].to[0]);
  });

  it('alerts at exactly the amount, not below it', async () => {
    const { org, manager } = await createWorld();
    const o = await createOwner(org);
    await change(o.token, { large_payment_alert: true, large_payment_threshold: 5000 });
    await pay(manager.token, { amount: 4999.99 });
    await pay(manager.token, { amount: 5000 });
    await until(() => sent.length >= 1);
    await quietPeriod();
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toMatch(/₹5,000 paid/);
  });

  it('does not alert the owner who recorded the payment', async () => {
    const { owner } = await createWorld();
    await change(owner.token, { large_payment_alert: true, large_payment_threshold: 1000 });
    await pay(owner.token, { amount: 90000, site_name: 'Site A' });
    await quietPeriod();
    expect(sent).toHaveLength(0);
  });

  it('does not alert twice for a retried submission', async () => {
    const { org, manager } = await createWorld();
    const o = await createOwner(org);
    await change(o.token, { large_payment_alert: true, large_payment_threshold: 1000 });
    const body = { amount: 20000, client_request_id: 'same-payment' };
    await pay(manager.token, body);
    await pay(manager.token, body);
    await until(() => sent.length >= 1);
    await quietPeriod();
    expect(sent).toHaveLength(1);
  });

  it('stays within the organisation', async () => {
    const a = await createWorld();
    const b = await createWorld();
    await change(b.owner.token, { large_payment_alert: true, large_payment_threshold: 1 });
    await pay(a.manager.token, { amount: 99999 });
    await quietPeriod();
    expect(sent).toHaveLength(0);
  });
});

describe('daily summary (v2)', () => {
  // 20:05 India time on 10 Nov 2026.
  const EVENING = new Date('2026-11-10T14:35:00.000Z');

  let sent;
  const send = async (users, title, body, data) => {
    sent.push({ to: users.map((u) => String(u._id)), title, body, data });
  };
  beforeEach(() => { sent = []; });

  async function busyDay() {
    const world = await createWorld();                                   // Site A
    await createSite(world.org, 'Site B');                               // records nothing
    const m = world.manager.token;
    await pay(m, { amount: 4500, paid_on: '2026-11-10T06:30:00.000Z' });                       // noon today
    await pay(m, { amount: 1250.5, category: 'labour', paid_on: '2026-11-09T19:00:00.000Z' }); // 00:30 today, India
    await pay(m, { amount: 999, paid_on: '2026-11-09T17:00:00.000Z' });                        // 22:30 yesterday
    await arrive(m, { received_on: '2026-11-10T05:00:00.000Z' });
    await arrive(m, { received_on: '2026-11-09T10:00:00.000Z' });                              // yesterday
    return world;
  }

  it('knows the India day and hour', () => {
    expect(indiaClock(EVENING)).toEqual({ day: '2026-11-10', hour: 20, dayStart: new Date('2026-11-09T18:30:00.000Z') });
    expect(indiaClock(new Date('2026-11-09T18:45:00.000Z')).day).toBe('2026-11-10');   // 00:15 IST
  });

  it("sends an opted-in owner today's India-day totals at their hour", async () => {
    const { owner } = await busyDay();
    await change(owner.token, { daily_summary: true });

    const result = await sendDailySummaries({ now: EVENING, send });
    expect(result).toEqual({ sent: 1, day: '2026-11-10' });
    expect(sent).toEqual([{
      to: [String(owner.user._id)],
      title: 'Today at your sites',
      body: '₹5,750.50 paid (2 payments) · 1 load arrived · 1 site recorded nothing',
      data: { type: 'daily_summary', day: '2026-11-10' },
    }]);
  });

  it('waits for the hour the owner chose', async () => {
    const { owner } = await busyDay();
    await change(owner.token, { daily_summary: true, daily_summary_hour: 21 });
    expect((await sendDailySummaries({ now: EVENING, send })).sent).toBe(0);
    expect((await sendDailySummaries({ now: new Date('2026-11-10T15:31:00.000Z'), send })).sent).toBe(1);  // 21:01
  });

  it('sends once a day however often it runs, and again the next day', async () => {
    const { owner } = await busyDay();
    await change(owner.token, { daily_summary: true });
    await sendDailySummaries({ now: EVENING, send });
    await sendDailySummaries({ now: new Date(EVENING.getTime() + 5 * 60 * 1000), send });
    await Promise.all([sendDailySummaries({ now: EVENING, send }), sendDailySummaries({ now: EVENING, send })]);
    expect(sent).toHaveLength(1);

    await sendDailySummaries({ now: new Date(EVENING.getTime() + 24 * 60 * 60 * 1000), send });
    expect(sent).toHaveLength(2);
    expect(sent[1].data.day).toBe('2026-11-11');
    expect(sent[1].body).toBe('No payments or deliveries were recorded at any site today.');
  });

  it('sends nothing to owners who did not ask, or to managers', async () => {
    await busyDay();
    expect((await sendDailySummaries({ now: EVENING, send })).sent).toBe(0);
    expect(await User.countDocuments({ dailySummarySentFor: { $ne: null } })).toBe(0);
  });

  it('skips a company whose subscription has lapsed', async () => {
    const { org, owner } = await busyDay();
    await change(owner.token, { daily_summary: true });
    await Organization.findByIdAndUpdate(org._id, { status: 'suspended' });
    expect((await sendDailySummaries({ now: EVENING, send })).sent).toBe(0);
  });

  it('gives each company its own numbers', async () => {
    const a = await busyDay();
    const b = await createWorld();
    await change(a.owner.token, { daily_summary: true });
    await change(b.owner.token, { daily_summary: true });
    await sendDailySummaries({ now: EVENING, send });
    const forB = sent.find((s) => s.to[0] === String(b.owner.user._id));
    expect(forB.body).toBe('No payments or deliveries were recorded at any site today.');
  });

  it('words the message for what happened', () => {
    const t = (over) => ({ totals: { payments_amount: 0, payments_count: 0, arrivals_count: 0, site_count: 2, active_site_count: 0, ...over } });
    expect(summaryMessage(t({ payments_amount: 800, payments_count: 1, active_site_count: 2 })).body)
      .toBe('₹800 paid (1 payment) · no loads arrived');
    expect(summaryMessage(t({ arrivals_count: 3, active_site_count: 1 })).body)
      .toBe('No payments · 3 loads arrived · 1 site recorded nothing');
    expect(summaryMessage(t({ site_count: 0 })).body).toBe('No sites yet.');
  });

  it('formats rupees the Indian way', () => {
    expect(formatRupees(125000)).toBe('₹1,25,000');
    expect(formatRupees(1250.5)).toBe('₹1,250.50');
  });
});
