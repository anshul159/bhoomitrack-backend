const request = require('supertest');
const app = require('../server');
const SitePayment = require('../models/SitePayment');
const MaterialArrival = require('../models/MaterialArrival');
const Attachment = require('../models/Attachment');
const Inventory = require('../models/Inventory');
const AuditLog = require('../models/AuditLog');
const { BILL_MAX_BYTES } = require('../utils/billImage');
const { createWorld, createSite, createManager, createInventory, bearer } = require('./helpers/factories');

// v2 site records: payments made at a site (with a bill photo) and material that
// arrived by the vehicle-load, measured by volume. Both are records only — no
// approval, no stock change — and a wrong one is voided by an owner, never deleted.

/** A small but genuine-looking JPEG: the right magic bytes, then noise. */
function jpegBytes(size = 2048) {
  const b = Buffer.alloc(size, 7);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  for (let i = 4; i < size; i++) b[i] = (i * 31) % 256;
  return b;
}
// Alerts and audit rows are written after the response has gone. Wait for what
// is expected rather than for a fixed time: a fixed 60 ms wait failed once on a
// busy machine.
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) return;
    await new Promise((r) => setTimeout(r, 10));
  }
};

const asDataUri = (buf, type = 'image/jpeg') => `data:${type};base64,${buf.toString('base64')}`;

const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

const payment = (overrides = {}) => ({
  category: 'material',
  amount: 4500,
  paid_to: 'Shree Sand Suppliers',
  payment_mode: 'upi',
  vehicle_number: 'ka 01 ab 1234',
  driver_name: 'Ramesh',
  ...overrides,
});

const arrival = (overrides = {}) => ({
  material_name: 'Sand',
  vehicle_type: 'tractor_trolley',
  vehicle_number: 'KA-05-MN-4321',
  length: 10, breadth: 6, height: 2, dimension_unit: 'ft',
  ...overrides,
});

describe('site payments (v2)', () => {
  it('lets a manager record a payment with a bill photo for their own site', async () => {
    const { site, manager } = await createWorld();
    const bill = jpegBytes();

    const res = await request(app).post('/api/payments').set(bearer(manager.token))
      .send(payment({ bill_image: asDataUri(bill), contractor_name: 'Kumar & Sons', contractor_phone: '98450 12345' }));

    expect(res.status).toBe(200);
    const p = res.body.data;
    expect(p.site_name).toBe(site.name);
    expect(p.amount).toBe(4500);
    expect(p.status).toBe('recorded');
    expect(p.has_bill).toBe(true);
    expect(p.vehicle_number).toBe('KA 01 AB 1234');   // normalised
    expect(p.contractor_phone).toBe('9845012345');
    expect(p.recorded_by_name).toBe('Test Manager');
    expect(p).not.toHaveProperty('bill_image');

    // The stored bytes are exactly the uploaded ones.
    const img = await request(app).get(`/api/attachments/${p.bill_attachment_id}`)
      .set(bearer(manager.token)).buffer(true).parse(binaryParser);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(img.body, bill)).toBe(0);
  });

  it('works without a bill photo, and contractor details stay optional', async () => {
    const { manager } = await createWorld();
    const res = await request(app).post('/api/payments').set(bearer(manager.token))
      .send({ category: 'labour', amount: 800, paid_to: 'Mason — daily wage' });
    expect(res.status).toBe(200);
    expect(res.body.data.has_bill).toBe(false);
    expect(res.body.data.bill_attachment_id).toBeNull();
    expect(res.body.data.contractor_name).toBe('');
    expect(res.body.data.reference_no).toBe('');
    expect(await Attachment.countDocuments()).toBe(0);
  });

  it('keeps a reference number (cheque, UTR, bill), trimmed, and returns it in the list', async () => {
    const { manager } = await createWorld();
    const res = await request(app).post('/api/payments').set(bearer(manager.token))
      .send(payment({ payment_mode: 'cheque', reference_no: '  CHQ 004512  ' }));
    expect(res.status).toBe(200);
    expect(res.body.data.reference_no).toBe('CHQ 004512');
    expect((await SitePayment.findById(res.body.data.id).lean()).reference_no).toBe('CHQ 004512');

    const list = await request(app).get('/api/payments/Site A').set(bearer(manager.token));
    expect(list.body.data[0].reference_no).toBe('CHQ 004512');
  });

  it('pins a manager to their own sites, and lets an owner record for any site', async () => {
    const { org, owner, manager } = await createWorld();
    const other = await createSite(org, 'Site B');

    const refused = await request(app).post('/api/payments').set(bearer(manager.token))
      .send(payment({ site_name: 'Site B' }));
    expect(refused.status).toBe(403);

    const byOwner = await request(app).post('/api/payments').set(bearer(owner.token))
      .send(payment({ site_name: 'Site B' }));
    expect(byOwner.status).toBe(200);
    expect(String(byOwner.body.data.site_id)).toBe(String(other._id));
    expect(byOwner.body.data.recorded_by_role).toBe('owner');
  });

  it.each([
    [{ amount: 0 }, /greater than 0/],
    [{ amount: 'abc' }, /greater than 0/],
    [{ amount: 5_00_00_00_000 }, /too large/],
    [{ category: 'bribe' }, /Choose what the payment was for/],
    [{ paid_to: '  ' }, /Paid to is required/],
    [{ payment_mode: 'barter' }, /Payment mode/],
    [{ paid_on: '2999-01-01' }, /future/],
    [{ paid_on: 'yesterday-ish' }, /valid date/],
    [{ contractor_phone: '12345' }, /10-digit/],
    [{ reference_no: 'x'.repeat(61) }, /Reference number must be 60 characters/],
    [{ reference_no: 12345 }, /Reference number must be text/],
    [{ bill_image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }, /JPEG, PNG or WebP/],
    [{ bill_image: asDataUri(Buffer.from('<html>not an image</html>')) }, /not a valid image/],
  ])('refuses %j', async (override, message) => {
    const { manager } = await createWorld();
    const res = await request(app).post('/api/payments').set(bearer(manager.token)).send(payment(override));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
    expect(await SitePayment.countDocuments()).toBe(0);
    expect(await Attachment.countDocuments()).toBe(0);
  });

  it('refuses a bill photo over the cap', async () => {
    const { manager } = await createWorld();
    const res = await request(app).post('/api/payments').set(bearer(manager.token))
      .send(payment({ bill_image: asDataUri(jpegBytes(BILL_MAX_BYTES + 1)) }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/too large/);
  });

  it('keeps one payment and one photo when the same submission is retried', async () => {
    const { manager } = await createWorld();
    const body = payment({ bill_image: asDataUri(jpegBytes()), client_request_id: 'pay-123' });

    const first = await request(app).post('/api/payments').set(bearer(manager.token)).send(body);
    const retry = await request(app).post('/api/payments').set(bearer(manager.token)).send(body);

    expect(retry.status).toBe(200);
    expect(retry.body.idempotent_replay).toBe(true);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await SitePayment.countDocuments()).toBe(1);
    expect(await Attachment.countDocuments()).toBe(1);
  });

  it('lists newest first with a summary that leaves out void entries', async () => {
    const { owner, manager } = await createWorld();
    const post = (b) => request(app).post('/api/payments').set(bearer(manager.token)).send(b);
    await post(payment({ category: 'labour', amount: 1000, paid_on: '2026-10-01' }));
    await post(payment({ category: 'labour', amount: 500, paid_on: '2026-11-02' }));
    const wrong = await post(payment({ category: 'material', amount: 9999, paid_on: '2026-11-03' }));
    await post(payment({ category: 'material', amount: 2000, paid_on: '2026-11-04' }));

    await request(app).put(`/api/payments/void/${wrong.body.data.id}`).set(bearer(owner.token))
      .send({ reason: 'Entered twice' });

    const res = await request(app).get('/api/payments/Site A').set(bearer(manager.token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((p) => p.amount)).toEqual([2000, 9999, 500, 1000]);
    expect(res.body.data[1].status).toBe('void');
    expect(res.body.summary.total_amount).toBe(3500);
    expect(res.body.summary.count).toBe(3);
    expect(res.body.summary.by_category).toEqual([
      { category: 'material', total: 2000, count: 1 },
      { category: 'labour', total: 1500, count: 2 },
    ]);

    const november = await request(app).get('/api/payments/Site A?from=2026-11-01&to=2026-11-30')
      .set(bearer(owner.token));
    expect(november.body.data).toHaveLength(3);
    expect(november.body.summary.total_amount).toBe(2500);
  });

  it('lets only an owner void, only with a reason, and only once — and audits it', async () => {
    const { owner, manager } = await createWorld();
    const created = await request(app).post('/api/payments').set(bearer(manager.token)).send(payment());
    const id = created.body.data.id;

    expect((await request(app).put(`/api/payments/void/${id}`).set(bearer(manager.token))
      .send({ reason: 'mine' })).status).toBe(403);
    expect((await request(app).put(`/api/payments/void/${id}`).set(bearer(owner.token))
      .send({})).status).toBe(400);

    const voided = await request(app).put(`/api/payments/void/${id}`).set(bearer(owner.token))
      .send({ reason: 'Wrong amount, re-entered' });
    expect(voided.status).toBe(200);
    expect(voided.body.data.status).toBe('void');
    expect(voided.body.data.void_reason).toBe('Wrong amount, re-entered');

    const again = await request(app).put(`/api/payments/void/${id}`).set(bearer(owner.token))
      .send({ reason: 'Again' });
    expect(again.status).toBe(400);

    // The record itself is still there.
    expect(await SitePayment.countDocuments({ _id: id })).toBe(1);
    // Audit writes are fire-and-forget: wait for both rows rather than a fixed time.
    await until(async () => (await AuditLog.countDocuments({ entity_id: id })) >= 2);
    const actions = (await AuditLog.find({ entity_id: id }).lean()).map((a) => a.action).sort();
    expect(actions).toEqual(['payment.record', 'payment.void']);
  });

  it('keeps one organisation out of another’s payments and bills', async () => {
    const a = await createWorld();
    const b = await createWorld();
    const created = await request(app).post('/api/payments').set(bearer(a.manager.token))
      .send(payment({ bill_image: asDataUri(jpegBytes()) }));
    const { id, bill_attachment_id: billId } = created.body.data;

    // Both orgs have a site called "Site A" — b must see only its own (none).
    const list = await request(app).get('/api/payments/Site A').set(bearer(b.owner.token));
    expect(list.body.data).toHaveLength(0);
    expect((await request(app).get(`/api/payments/${a.site._id}`).set(bearer(b.owner.token))).status).toBe(404);
    expect((await request(app).get(`/api/attachments/${billId}`).set(bearer(b.owner.token))).status).toBe(404);
    expect((await request(app).put(`/api/payments/void/${id}`).set(bearer(b.owner.token))
      .send({ reason: 'not yours' })).status).toBe(404);
  });

  it('refuses a bill to a manager of a different site in the same organisation', async () => {
    const { org, manager } = await createWorld();
    const otherSite = await createSite(org, 'Site B');
    const otherManager = await createManager(org, otherSite);
    const created = await request(app).post('/api/payments').set(bearer(manager.token))
      .send(payment({ bill_image: asDataUri(jpegBytes()) }));

    const res = await request(app).get(`/api/attachments/${created.body.data.bill_attachment_id}`)
      .set(bearer(otherManager.token));
    expect(res.status).toBe(403);
    expect((await request(app).get('/api/payments/Site A').set(bearer(otherManager.token))).status).toBe(403);
  });
});

describe('material arrivals by volume (v2)', () => {
  it('computes the volume on the server from length x breadth x height in feet', async () => {
    const { manager } = await createWorld();
    const res = await request(app).post('/api/arrivals').set(bearer(manager.token))
      .send(arrival({ volume_cft: 99999 }));   // a client-sent volume is ignored

    expect(res.status).toBe(200);
    const a = res.body.data;
    expect(a.volume_cft).toBe(120);
    expect(a.volume_m3).toBeCloseTo(3.398, 3);
    expect(a.volume_brass).toBe(1.2);
    expect(a.vehicle_number).toBe('KA-05-MN-4321');
    expect(a.status).toBe('recorded');
  });

  it('converts metres to cubic feet', async () => {
    const { manager } = await createWorld();
    const res = await request(app).post('/api/arrivals').set(bearer(manager.token))
      .send(arrival({ length: 3, breadth: 2, height: 0.5, dimension_unit: 'm', vehicle_type: 'tipper' }));
    expect(res.body.data.volume_m3).toBe(3);
    expect(res.body.data.volume_cft).toBeCloseTo(105.94, 2);
  });

  it('links to the site’s stock row by name without changing stock', async () => {
    const { org, site, manager } = await createWorld();
    const sand = await createInventory(org, site, { name: 'River Sand', quantity: 40, unit: 'cft' });

    const res = await request(app).post('/api/arrivals').set(bearer(manager.token))
      .send(arrival({ material_name: 'river sand' }));

    expect(res.body.data.material_name).toBe('River Sand');
    expect(String(res.body.data.inventory_id)).toBe(String(sand._id));
    expect((await Inventory.findById(sand._id).lean()).quantity).toBe(40);
  });

  it.each([
    [{ vehicle_number: '' }, /Vehicle number is required/],
    [{ vehicle_number: '!!!' }, /letters or digits/],
    [{ vehicle_type: 'bullock_cart' }, /vehicle type/],
    [{ material_name: '' }, /Material is required/],
    [{ height: 0 }, /height/],
    [{ length: 140 }, /too large/],
    [{ dimension_unit: 'inch' }, /ft or m/],
  ])('refuses %j', async (override, message) => {
    const { manager } = await createWorld();
    const res = await request(app).post('/api/arrivals').set(bearer(manager.token)).send(arrival(override));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
    expect(await MaterialArrival.countDocuments()).toBe(0);
  });

  it('totals recorded arrivals per material and leaves out void ones', async () => {
    const { owner, manager } = await createWorld();
    const post = (b) => request(app).post('/api/arrivals').set(bearer(manager.token)).send(b);
    await post(arrival());                                   // 120 cft sand
    await post(arrival({ height: 2.5 }));                    // 150 cft sand
    const wrong = await post(arrival({ length: 20 }));       // 240 cft — voided
    await post(arrival({ material_name: 'Gitti 20mm', vehicle_type: 'tipper' })); // 120 cft

    await request(app).put(`/api/arrivals/void/${wrong.body.data.id}`).set(bearer(owner.token))
      .send({ reason: 'Measured wrong' });

    const res = await request(app).get('/api/arrivals/Site A').set(bearer(owner.token));
    expect(res.body.data).toHaveLength(4);
    expect(res.body.summary.count).toBe(3);
    expect(res.body.summary.by_material).toEqual([
      { material_name: 'Sand', volume_cft: 270, volume_m3: expect.any(Number), volume_brass: 2.7, count: 2 },
      { material_name: 'Gitti 20mm', volume_cft: 120, volume_m3: expect.any(Number), volume_brass: 1.2, count: 1 },
    ]);
  });

  it('keeps one submission to one record when retried', async () => {
    const { manager } = await createWorld();
    const body = arrival({ client_request_id: 'arr-1' });
    await request(app).post('/api/arrivals').set(bearer(manager.token)).send(body);
    const retry = await request(app).post('/api/arrivals').set(bearer(manager.token)).send(body);
    expect(retry.body.idempotent_replay).toBe(true);
    expect(await MaterialArrival.countDocuments()).toBe(1);
  });

  it('lets only an owner void an arrival', async () => {
    const { manager } = await createWorld();
    const created = await request(app).post('/api/arrivals').set(bearer(manager.token)).send(arrival());
    const res = await request(app).put(`/api/arrivals/void/${created.body.data.id}`)
      .set(bearer(manager.token)).send({ reason: 'oops' });
    expect(res.status).toBe(403);
  });
});

describe('site records across the organisation (v2)', () => {
  const readExport = (token) => request(app).get('/api/org/export').set(bearer(token)).buffer(true)
    .parse((r, cb) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => cb(null, d)); });

  it('exports payments, arrivals and the bill photos themselves', async () => {
    const { owner, manager } = await createWorld();
    const bill = jpegBytes();
    await request(app).post('/api/payments').set(bearer(manager.token)).send(payment({ bill_image: asDataUri(bill) }));
    await request(app).post('/api/arrivals').set(bearer(manager.token)).send(arrival());

    const res = await readExport(owner.token);
    const body = JSON.parse(res.body);
    expect(body.payments).toHaveLength(1);
    expect(body.arrivals).toHaveLength(1);
    expect(body.attachments).toHaveLength(1);
    expect(body.counts).toMatchObject({ payments: 1, arrivals: 1, attachments: 1 });
    expect(Buffer.from(body.attachments[0].data, 'base64').equals(bill)).toBe(true);
  });

  it('deletes them with the organisation', async () => {
    const { org, owner, manager } = await createWorld();
    await request(app).post('/api/payments').set(bearer(manager.token)).send(payment({ bill_image: asDataUri(jpegBytes()) }));
    await request(app).post('/api/arrivals').set(bearer(manager.token)).send(arrival());

    const res = await request(app).delete('/api/org').set(bearer(owner.token)).send({ confirmName: org.name });
    expect(res.status).toBe(200);
    expect(await SitePayment.countDocuments({ orgId: org._id })).toBe(0);
    expect(await MaterialArrival.countDocuments({ orgId: org._id })).toBe(0);
    expect(await Attachment.countDocuments({ orgId: org._id })).toBe(0);
  });

  it('carries the new site name onto payments and arrivals when a site is renamed', async () => {
    const { site, owner, manager } = await createWorld();
    await request(app).post('/api/payments').set(bearer(manager.token)).send(payment());
    await request(app).post('/api/arrivals').set(bearer(manager.token)).send(arrival());

    await request(app).put(`/api/sites/rename/${site._id}`).set(bearer(owner.token)).send({ name: 'Tower 2' });

    expect((await SitePayment.findOne().lean()).site_name).toBe('Tower 2');
    expect((await MaterialArrival.findOne().lean()).site_name).toBe('Tower 2');
  });
});
