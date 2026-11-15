const request = require('supertest');
const app = require('../server');
const ServiceRequest = require('../models/ServiceRequest');
const AuditLog = require('../models/AuditLog');
const push = require('../utils/push');
const sr = require('../utils/serviceRequests');
const { createWorld, createSite, bearer } = require('./helpers/factories');

// Service requests (BhoomiTrack Services, plan §6.2): one object behind every door.

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) return;
    await new Promise((r) => setTimeout(r, 10));
  }
};

const gst = (overrides = {}) => ({
  service_id: 'tax.gst_filing',
  consent: true,
  details: { frequency: 'Monthly', from_period: 'This month', note: 'Two sites in Noida' },
  ...overrides,
});

const quote = (site, overrides = {}) => ({
  service_id: 'materials.quote',
  consent: true,
  details: { site_id: String(site._id), material: 'OPC 53 cement', quantity: 400, unit: 'Bags', needed_by: '2026-11-20' },
  ...overrides,
});

const DESK = 'Prerna';

describe('the catalogue', () => {
  it('is served to an owner with the six doors', async () => {
    const { owner } = await createWorld();
    const res = await request(app).get('/api/services/catalogue').set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data.doors.map((d) => d.id)).toEqual(['materials', 'insurance', 'credit', 'tax', 'compliance', 'experts']);
    const wc = res.body.data.services.find((s) => s.id === 'insurance.workers_compensation');
    expect(wc.status).toBe('interest');
  });

  it('is refused to a manager, like every Services route', async () => {
    const { manager, site } = await createWorld();
    for (const [method, path, body] of [
      ['get', '/api/services/catalogue'],
      ['get', '/api/services/requests'],
      ['post', '/api/services/requests', quote(site)],
    ]) {
      const res = await request(app)[method](path).set(bearer(manager.token)).send(body);
      expect([path, res.status]).toEqual([path, 403]);
    }
  });
});

describe('sending a request', () => {
  it('creates a numbered request with the consent snapshotted and the site attached', async () => {
    const { owner, site } = await createWorld();
    const res = await request(app).post('/api/services/requests').set(bearer(owner.token)).send(quote(site));
    expect(res.status).toBe(201);
    const r = res.body.data;
    expect(r.number).toMatch(/^SR-\d{6}$/);
    expect(r.status).toBe('requested');
    expect(r.title).toBe('Get quotes');
    expect(r.site_name).toBe(site.name);
    expect(r.details).toEqual({ site_id: String(site._id), material: 'OPC 53 cement', quantity: 400, unit: 'Bags', needed_by: '2026-11-20' });
    expect(r.consent.shares).toContain('Site name and location');
    expect(r.consent.shared_with).toMatch(/BhoomiTrack desk/);
    expect(r.timeline).toHaveLength(1);
    expect(r.timeline[0]).toMatchObject({ status: 'requested', by: 'customer' });
    expect(r.outcome).not.toHaveProperty('commission_paise');
  });

  it('refuses without consent', async () => {
    const { owner } = await createWorld();
    const res = await request(app).post('/api/services/requests').set(bearer(owner.token)).send(gst({ consent: undefined }));
    expect(res.status).toBe(400);
    expect(await ServiceRequest.countDocuments()).toBe(0);
  });

  it('validates the answers against the catalogue, field by field', async () => {
    const { owner, site } = await createWorld();
    const cases = [
      [gst({ details: { from_period: 'This month' } }), 'frequency'],                    // required
      [gst({ details: { frequency: 'Weekly', from_period: 'This month' } }), 'frequency'], // not an option
      [quote(site, { details: { site_id: String(site._id), material: 'Sand', quantity: -3, unit: 'Bags' } }), 'quantity'],
      [quote(site, { details: { site_id: String(site._id), material: 'Sand', quantity: 3, unit: 'Bags', needed_by: 'soon' } }), 'needed_by'],
      [quote(site, { details: { site_id: '64b000000000000000000000', material: 'Sand', quantity: 3, unit: 'Bags' } }), 'site_id'],
    ];
    for (const [body, field] of cases) {
      const res = await request(app).post('/api/services/requests').set(bearer(owner.token)).send(body);
      expect([field, res.status, res.body.field]).toEqual([field, 400, field]);
    }
  });

  it('keeps only the keys the catalogue asked for', async () => {
    const { owner } = await createWorld();
    const res = await request(app).post('/api/services/requests').set(bearer(owner.token))
      .send(gst({ details: { frequency: 'Quarterly', from_period: 'Next month', $where: 'x', admin: true } }));
    expect(res.status).toBe(201);
    expect(Object.keys(res.body.data.details).sort()).toEqual(['frequency', 'from_period']);
  });

  it('refuses a site from another organisation', async () => {
    const a = await createWorld();
    const b = await createWorld();
    const res = await request(app).post('/api/services/requests').set(bearer(a.owner.token)).send(quote(b.site));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('site_id');
  });

  it('refuses a service that does not exist', async () => {
    const { owner } = await createWorld();
    const res = await request(app).post('/api/services/requests').set(bearer(owner.token)).send({ service_id: 'tax.nothing', consent: true });
    expect(res.status).toBe(404);
  });

  it('returns the first request when the same send is retried', async () => {
    const { owner } = await createWorld();
    const body = gst({ client_request_id: 'retry-1' });
    const first = await request(app).post('/api/services/requests').set(bearer(owner.token)).send(body);
    const again = await request(app).post('/api/services/requests').set(bearer(owner.token)).send(body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await ServiceRequest.countDocuments()).toBe(1);
  });

  it('audits the request', async () => {
    const { owner, org } = await createWorld();
    await request(app).post('/api/services/requests').set(bearer(owner.token)).send(gst());
    await until(() => AuditLog.exists({ orgId: org._id, action: 'service_request.create' }));
    const row = await AuditLog.findOne({ orgId: org._id, action: 'service_request.create' }).lean();
    expect(row.entity_label).toMatch(/^SR-\d{6} · GST filing$/);
  });
});

describe('interest in a service that is not live', () => {
  it('records one interest per service, however often it is tapped, with nothing shared', async () => {
    const { owner } = await createWorld();
    const body = { service_id: 'insurance.workers_compensation' };
    const first = await request(app).post('/api/services/requests').set(bearer(owner.token)).send(body);
    const again = await request(app).post('/api/services/requests').set(bearer(owner.token)).send(body);
    expect(first.status).toBe(201);
    expect(first.body.data.status).toBe('interest');
    expect(first.body.data.consent).toBeNull();
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await ServiceRequest.countDocuments({ status: 'interest' })).toBe(1);
  });

  it('keeps interest out of the default request list', async () => {
    const { owner } = await createWorld();
    await request(app).post('/api/services/requests').set(bearer(owner.token)).send({ service_id: 'credit.working_capital' });
    await request(app).post('/api/services/requests').set(bearer(owner.token)).send(gst());
    const list = await request(app).get('/api/services/requests').set(bearer(owner.token));
    expect(list.body.data.map((r) => r.service_id)).toEqual(['tax.gst_filing']);
    const interest = await request(app).get('/api/services/requests?state=interest').set(bearer(owner.token));
    expect(interest.body.data.map((r) => r.service_id)).toEqual(['credit.working_capital']);
  });
});

describe('a request moving through the desk', () => {
  let sent;
  beforeEach(() => { sent = jest.spyOn(push, 'sendToUsers').mockResolvedValue(); });
  afterEach(() => sent.mockRestore());

  it('goes requested → options ready → chosen → done, with a saving and its basis', async () => {
    const { owner, site } = await createWorld();
    const created = (await request(app).post('/api/services/requests').set(bearer(owner.token)).send(quote(site))).body.data;

    await sr.deskSetStatus(DESK, created.id, 'in_review', 'Calling three dealers in Noida');
    await sr.deskAddOption(DESK, created.id, { label: 'Shree Cement Traders', provider: 'Shree Cement Traders', amount_rupees: '1,44,800', summary: '₹362 a bag, delivered' });
    await sr.deskAddOption(DESK, created.id, { label: 'Gupta Building Store', amount_rupees: 148000 });
    await sr.deskSetStatus(DESK, created.id, 'options_ready', 'Two quotes ready');

    let r = (await request(app).get(`/api/services/requests/${created.id}`).set(bearer(owner.token))).body.data;
    expect(r.status).toBe('options_ready');
    expect(r.needs_you).toBe(true);
    expect(r.options).toHaveLength(2);
    expect(r.options[0].amount_paise).toBe(14480000);
    // The desk's changes are pushed to the owner.
    await until(() => sent.mock.calls.length >= 2);
    expect(sent.mock.calls.some((c) => /Options ready/.test(c[1]))).toBe(true);

    const chose = await request(app).post(`/api/services/requests/${created.id}/choose`).set(bearer(owner.token))
      .send({ option_id: r.options[0].id });
    expect(chose.status).toBe(200);
    expect(chose.body.data.status).toBe('in_progress');
    expect(chose.body.data.chosen_option_id).toBe(r.options[0].id);

    await sr.deskMarkDone(DESK, created.id, {
      fee_rupees: 0, commission_rupees: 1448, saved_rupees: 9200, saved_basis: '400 bags at ₹362 against your last rate of ₹385',
    });
    r = (await request(app).get(`/api/services/requests/${created.id}`).set(bearer(owner.token))).body.data;
    expect(r.status).toBe('done');
    expect(r.outcome).toEqual({ fee_paise: 0, saved_paise: 920000, saved_basis: '400 bags at ₹362 against your last rate of ₹385' });
    expect(r.timeline.map((t) => t.status)).toEqual(['requested', 'in_review', 'options_ready', 'in_progress', 'done']);
    expect(r.timeline.map((t) => t.by)).toEqual(['customer', 'desk', 'desk', 'customer', 'desk']);

    // The commission is stored for us and never shown to the owner.
    const stored = await ServiceRequest.findById(created.id).lean();
    expect(stored.outcome.commission_paise).toBe(144800);

    const actions = (await AuditLog.find({ entity: 'service_request' }).lean()).map((a) => a.action);
    for (const a of ['create', 'status', 'option', 'choose', 'done']) expect(actions).toContain(`service_request.${a}`);
    const deskRow = await AuditLog.findOne({ action: 'service_request.done' }).lean();
    expect(deskRow.actor_name).toBe('BhoomiTrack desk (Prerna)');
  });

  it('refuses a saving with no basis', async () => {
    const { owner } = await createWorld();
    const created = (await request(app).post('/api/services/requests').set(bearer(owner.token)).send(gst())).body.data;
    await expect(sr.deskMarkDone(DESK, created.id, { saved_rupees: 5000, saved_basis: '' })).rejects.toThrow(/how the saving was worked out/);
    expect((await ServiceRequest.findById(created.id).lean()).status).toBe('requested');
  });

  it('refuses options ready with no options, and done through set-status', async () => {
    const { owner } = await createWorld();
    const created = (await request(app).post('/api/services/requests').set(bearer(owner.token)).send(gst())).body.data;
    await expect(sr.deskSetStatus(DESK, created.id, 'options_ready')).rejects.toThrow(/at least one option/);
    await expect(sr.deskSetStatus(DESK, created.id, 'done')).rejects.toThrow(/Mark done/);
  });

  it('lets the owner choose only in options ready, and only an option that exists', async () => {
    const { owner } = await createWorld();
    const created = (await request(app).post('/api/services/requests').set(bearer(owner.token)).send(gst())).body.data;
    let res = await request(app).post(`/api/services/requests/${created.id}/choose`).set(bearer(owner.token)).send({ option_id: 'nope' });
    expect(res.status).toBe(404);
    const withOption = await sr.deskAddOption(DESK, created.id, { label: 'Monthly plan', amount_rupees: 1000 });
    res = await request(app).post(`/api/services/requests/${created.id}/choose`).set(bearer(owner.token))
      .send({ option_id: withOption.options[0].id });
    expect(res.status).toBe(409);       // still 'requested', not 'options_ready'
  });

  it('lets the owner cancel before the work starts, and not after', async () => {
    const { owner } = await createWorld();
    const a = (await request(app).post('/api/services/requests').set(bearer(owner.token)).send(gst())).body.data;
    const res = await request(app).post(`/api/services/requests/${a.id}/cancel`).set(bearer(owner.token)).send({ reason: 'Our CA does it' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
    expect(res.body.data.timeline.at(-1).note).toBe('Our CA does it');

    const b = (await request(app).post('/api/services/requests').set(bearer(owner.token)).send(gst({ client_request_id: 'b' }))).body.data;
    await sr.deskSetStatus(DESK, b.id, 'in_progress', 'The CA has started');
    const late = await request(app).post(`/api/services/requests/${b.id}/cancel`).set(bearer(owner.token));
    expect(late.status).toBe(409);
  });

  it('carries messages both ways, and refuses them once the request is closed', async () => {
    const { owner } = await createWorld();
    const r = (await request(app).post('/api/services/requests').set(bearer(owner.token)).send(gst())).body.data;
    await request(app).post(`/api/services/requests/${r.id}/messages`).set(bearer(owner.token)).send({ text: 'GSTIN is on the bill' });
    await sr.addMessage({ desk: DESK }, { _id: r.id }, 'Thanks, please send October’s bills');
    const got = (await request(app).get(`/api/services/requests/${r.id}`).set(bearer(owner.token))).body.data;
    expect(got.messages.map((m) => [m.from, m.by_name])).toEqual([['customer', 'Test Owner'], ['desk', 'BhoomiTrack']]);

    const empty = await request(app).post(`/api/services/requests/${r.id}/messages`).set(bearer(owner.token)).send({ text: '  ' });
    expect(empty.status).toBe(400);
    await request(app).post(`/api/services/requests/${r.id}/cancel`).set(bearer(owner.token));
    const closed = await request(app).post(`/api/services/requests/${r.id}/messages`).set(bearer(owner.token)).send({ text: 'hello?' });
    expect(closed.status).toBe(409);
  });

  it('takes one rating, only once the request is done', async () => {
    const { owner } = await createWorld();
    const r = (await request(app).post('/api/services/requests').set(bearer(owner.token)).send(gst())).body.data;
    let res = await request(app).post(`/api/services/requests/${r.id}/rating`).set(bearer(owner.token)).send({ rating: 'good' });
    expect(res.status).toBe(409);
    await sr.deskMarkDone(DESK, r.id, { fee_rupees: 1000 });
    res = await request(app).post(`/api/services/requests/${r.id}/rating`).set(bearer(owner.token)).send({ rating: 'good' });
    expect(res.status).toBe(200);
    res = await request(app).post(`/api/services/requests/${r.id}/rating`).set(bearer(owner.token)).send({ rating: 'bad' });
    expect(res.status).toBe(409);
  });

  it('does not push the owner about their own moves', async () => {
    const { owner } = await createWorld();
    const r = (await request(app).post('/api/services/requests').set(bearer(owner.token)).send(gst())).body.data;
    await request(app).post(`/api/services/requests/${r.id}/messages`).set(bearer(owner.token)).send({ text: 'hi' });
    await request(app).post(`/api/services/requests/${r.id}/cancel`).set(bearer(owner.token));
    await new Promise((res) => setTimeout(res, 50));
    expect(sent).not.toHaveBeenCalled();
  });
});

describe('service requests across organisations', () => {
  it('never shows, changes or messages another organisation’s request', async () => {
    const a = await createWorld();
    const b = await createWorld();
    const theirs = (await request(app).post('/api/services/requests').set(bearer(b.owner.token)).send(gst())).body.data;
    await sr.deskAddOption(DESK, theirs.id, { label: 'Plan' });
    await sr.deskSetStatus(DESK, theirs.id, 'options_ready');

    const list = await request(app).get('/api/services/requests?state=all').set(bearer(a.owner.token));
    expect(list.body.data).toHaveLength(0);
    for (const [method, path, body] of [
      ['get', `/api/services/requests/${theirs.id}`],
      ['post', `/api/services/requests/${theirs.id}/messages`, { text: 'hi' }],
      ['post', `/api/services/requests/${theirs.id}/choose`, { option_id: 'x' }],
      ['post', `/api/services/requests/${theirs.id}/cancel`],
      ['post', `/api/services/requests/${theirs.id}/rating`, { rating: 'good' }],
    ]) {
      const res = await request(app)[method](path).set(bearer(a.owner.token)).send(body);
      expect([path, res.status]).toEqual([path, 404]);
    }
    expect((await ServiceRequest.findById(theirs.id).lean()).status).toBe('options_ready');
  });

  it('a second site in the same organisation is fine', async () => {
    const { org, owner } = await createWorld();
    const second = await createSite(org, 'Site B');
    const res = await request(app).post('/api/services/requests').set(bearer(owner.token)).send(quote(second));
    expect(res.status).toBe(201);
    expect(res.body.data.site_name).toBe('Site B');
  });
});

describe('interest tapped twice at once', () => {
  it('still leaves one row', async () => {
    const { owner } = await createWorld();
    await ServiceRequest.init();
    const body = { service_id: 'insurance.group_health' };
    const results = await Promise.all([1, 2, 3].map(() =>
      request(app).post('/api/services/requests').set(bearer(owner.token)).send(body)));
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(await ServiceRequest.countDocuments({ status: 'interest' })).toBe(1);
  });
});
