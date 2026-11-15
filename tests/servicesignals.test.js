const request = require('supertest');
const app = require('../server');
const Organization = require('../models/Organization');
const CompanyDocument = require('../models/CompanyDocument');
const ServiceRequest = require('../models/ServiceRequest');
const sr = require('../utils/serviceRequests');
const { buildCompanyFile } = require('../utils/companyFile');
const { allSignals, topSignals, expirySignals, dueDateSignals, missingSignals } = require('../utils/serviceSignals');
const { dueWithin } = require('../config/complianceCalendar');
const { createWorld, bearer } = require('./helpers/factories');

// "For you" and the compliance calendar (BhoomiTrack Services, plan §6.5).

const now = new Date('2026-11-15T06:00:00Z');       // 15 Nov, India
const profile = { own_workers: 2, contract_workers: 10, vehicles: 0, entity_type: 'proprietorship', client_types: ['private'], work_types: ['building'], state: 'DL' };
const doc = (slot, expires, extra = {}) => ({
  slot, status: 'active', not_needed: false, files: [], createdAt: now,
  expires_on: expires ? new Date(`${expires}T00:00:00Z`) : null, ...extra,
});

describe('the compliance calendar', () => {
  it('finds GST dates only for a business with a GSTIN', () => {
    const none = dueWithin({ profile: {}, inPlace: new Set() }, '2026-11-15', 10);
    expect(none.map((d) => d.id)).not.toContain('gstr3b');
    const gst = dueWithin({ profile: { gstin: '27AAPFU0939F1ZV' }, inPlace: new Set() }, '2026-11-15', 10);
    expect(gst.find((d) => d.id === 'gstr3b')).toMatchObject({ due_on: '2026-11-20', days_left: 5 });
  });

  it('finds TDS and PF dates only once their registrations are on file', () => {
    const ctx = { profile: {}, inPlace: new Set(['tax.tan', 'labour.pf']) };
    const ids = dueWithin(ctx, '2026-12-01', 15).map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(['tds_payment', 'pf_esi', 'advance_tax']));
  });

  it('crosses the year end', () => {
    const d = dueWithin({ profile: {}, inPlace: new Set(['tax.tan']) }, '2026-12-28', 10);
    expect(d.find((x) => x.id === 'tds_payment').due_on).toBe('2027-01-07');
  });
});

describe('signals (pure)', () => {
  it('raises an expired paper above an expiring one, and says where', () => {
    const file = buildCompanyFile({ ...profile, contract_workers: 60 },
      [{ _id: 's1', name: 'Sector 62' }],
      [doc('labour.licence', '2026-11-27'), doc('sites.site_policy', '2026-11-10', { site_id: 's1' })], now);
    const s = expirySignals(file);
    const ranked = allSignals(file, { profile: {}, inPlace: new Set() }, '2026-11-15').filter((x) => x.kind === 'expiry');
    expect(ranked.map((x) => x.title)).toEqual([
      'Site insurance at Sector 62 has expired',
      'Labour licence expires in 12 days',
    ]);
    const licence = s.find((x) => x.slot === 'labour.licence');
    expect(licence.service_id).toBe('compliance.labour_licence');   // live, so we offer to renew
    const policy = s.find((x) => x.slot === 'sites.site_policy');
    expect(policy.service_id).toBeNull();                            // insurance is not live yet
    expect(policy.line).toMatch(/Upload the new one/);
  });

  it('raises a statutory date within five days, not six', () => {
    const ctx = { profile: { gstin: '27AAPFU0939F1ZV' }, inPlace: new Set() };
    expect(dueDateSignals(ctx, '2026-11-15').map((x) => x.id)).toContain('due:gstr3b:2026-11-20');
    expect(dueDateSignals(ctx, '2026-11-14').map((x) => x.id)).not.toContain('due:gstr3b:2026-11-20');
    expect(dueDateSignals(ctx, '2026-11-19')[0].title).toBe('GSTR-3B (tax payment) is due tomorrow');
  });

  it('raises a missing paper only when we can get it done', () => {
    const file = buildCompanyFile(profile, [], [], now);
    const s = missingSignals(file);
    expect(s.map((x) => x.slot)).toContain('labour.bocw');
    // Titles as written: an acronym keeps its capitals.
    expect(s.find((x) => x.slot === 'company.pan').title).toBe('PAN card is not on file');
    expect(s.map((x) => x.slot)).not.toContain('insurance.wc_policy');     // interest only
    expect(s.map((x) => x.slot)).not.toContain('company.cancelled_cheque'); // no service at all
  });

  it('never suggests credit', () => {
    const file = buildCompanyFile(profile, [], [], now);
    const all = allSignals(file, { profile, inPlace: new Set() }, '2026-11-15');
    expect(all.every((s) => !String(s.service_id).startsWith('credit.'))).toBe(true);
  });

  it('shows at most two, skipping the dismissed until their date passes', () => {
    const signals = [{ id: 'a', priority: 3 }, { id: 'b', priority: 2 }, { id: 'c', priority: 1 }];
    expect(topSignals(signals, [], now).map((s) => s.id)).toEqual(['a', 'b']);
    const dismissed = [{ signal_id: 'a', until: new Date(now.getTime() + 1000) }];
    expect(topSignals(signals, dismissed, now).map((s) => s.id)).toEqual(['b', 'c']);
    const lapsed = [{ signal_id: 'a', until: new Date(now.getTime() - 1000) }];
    expect(topSignals(signals, lapsed, now).map((s) => s.id)).toEqual(['a', 'b']);
    expect(topSignals(signals, [], now)[0]).not.toHaveProperty('priority');
  });
});

describe('GET /api/services/home', () => {
  it('gives a new owner the company file and the doors, with no requests or savings', async () => {
    const { owner } = await createWorld();
    const res = await request(app).get('/api/services/home').set(bearer(owner.token));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.company_file.score.ready).toBe(0);
    expect(d.company_file.questions.length).toBeGreaterThan(0);
    expect(d.requests).toEqual([]);
    expect(d.savings.total_paise).toBe(0);
    expect(d.signals.length).toBeLessThanOrEqual(2);
    expect(d.badge).toBe(0);
  });

  it('counts a choice to make and an expired paper on the badge, and adds up the year’s savings', async () => {
    const { owner, org } = await createWorld();
    await CompanyDocument.create({ orgId: org._id, slot: 'company.shop_establishment', title: 'S&E', expires_on: new Date('2020-01-01'), files: [] });
    const make = async (id) => (await request(app).post('/api/services/requests').set(bearer(owner.token))
      .send({ service_id: 'experts.ca', consent: true, details: { question: 'GST notice' }, client_request_id: id })).body.data;
    const waiting = await make('w');
    await sr.deskAddOption('Anshul', waiting.id, { label: 'Tuesday 11 am' });
    await sr.deskSetStatus('Anshul', waiting.id, 'options_ready');
    const done = await make('d');
    await sr.deskMarkDone('Anshul', done.id, { saved_rupees: 2300, saved_basis: 'Notice answered: ₹2,300 late fee waived' });

    const d = (await request(app).get('/api/services/home').set(bearer(owner.token))).body.data;
    expect(d.badge).toBe(2);
    expect(d.requests.map((r) => r.status)).toEqual(['options_ready']);
    expect(d.savings).toMatchObject({ total_paise: 230000, count: 1 });
    expect(d.signals[0].title).toMatch(/Shop and establishment registration has expired/);

    const savings = (await request(app).get('/api/services/savings').set(bearer(owner.token))).body.data;
    expect(savings.items).toHaveLength(1);
    expect(savings.items[0].saved_basis).toMatch(/late fee waived/);
  });

  it('keeps a dismissed suggestion away for 30 days', async () => {
    const { owner, org } = await createWorld();
    await request(app).put('/api/org/settings').set(bearer(owner.token)).send({ profile });
    const first = (await request(app).get('/api/services/home').set(bearer(owner.token))).body.data.signals;
    expect(first.length).toBe(2);

    const res = await request(app).post(`/api/services/signals/${encodeURIComponent(first[0].id)}/dismiss`).set(bearer(owner.token));
    expect(res.status).toBe(200);
    // Twice is still one entry.
    await request(app).post(`/api/services/signals/${encodeURIComponent(first[0].id)}/dismiss`).set(bearer(owner.token));
    const saved = await Organization.findById(org._id).lean();
    expect(saved.services.dismissed.filter((x) => x.signal_id === first[0].id)).toHaveLength(1);
    const days = (new Date(saved.services.dismissed[0].until) - Date.now()) / 86400000;
    expect(Math.round(days)).toBe(30);

    const after = (await request(app).get('/api/services/home').set(bearer(owner.token))).body.data.signals;
    expect(after.map((s) => s.id)).not.toContain(first[0].id);
    expect(after[0].id).toBe(first[1].id);
  });

  it('refuses a malformed suggestion id, and a manager', async () => {
    const { owner, manager } = await createWorld();
    expect((await request(app).post('/api/services/signals/%24where/dismiss').set(bearer(owner.token))).status).toBe(400);
    expect((await request(app).get('/api/services/home').set(bearer(manager.token))).status).toBe(403);
  });

  it("never counts another organisation's requests or papers", async () => {
    const a = await createWorld();
    const b = await createWorld();
    await CompanyDocument.create({ orgId: b.org._id, slot: 'company.shop_establishment', expires_on: new Date('2020-01-01'), files: [] });
    const r = (await request(app).post('/api/services/requests').set(bearer(b.owner.token))
      .send({ service_id: 'experts.ca', consent: true, details: { question: 'x' } })).body.data;
    await sr.deskMarkDone('Anshul', r.id, { saved_rupees: 500, saved_basis: 'Some saving worked out properly' });
    const d = (await request(app).get('/api/services/home').set(bearer(a.owner.token))).body.data;
    expect(d.badge).toBe(0);
    expect(d.savings.total_paise).toBe(0);
    expect(await ServiceRequest.countDocuments()).toBe(1);
  });
});
