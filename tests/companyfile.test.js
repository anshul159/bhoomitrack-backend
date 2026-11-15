const request = require('supertest');
const app = require('../server');
const CompanyDocument = require('../models/CompanyDocument');
const AuditLog = require('../models/AuditLog');
const storageModule = require('../utils/storage');
const { buildCompanyFile, slotStatus, daysUntil } = require('../utils/companyFile');
const { getRule, RULES } = require('../config/companyFileRules');
const { getService } = require('../config/serviceCatalogue');
const { createWorld, createSite, bearer } = require('./helpers/factories');

// The company file (BhoomiTrack Services, plan §5.3 and §6.3).

const pdf = (size = 4096) => {
  const b = Buffer.alloc(size, 0x20);
  b.write('%PDF-1.7\n', 0, 'latin1');
  return b;
};
const jpeg = (size = 2048) => {
  const b = Buffer.alloc(size, 7);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  return b;
};
const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const isoDay = (offsetDays) => new Date(Date.now() + offsetDays * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);

const setProfile = (owner, profile) =>
  request(app).put('/api/org/settings').set(bearer(owner.token)).send({ profile });

const uploadDoc = (owner, fields, files = [[pdf(), 'licence.pdf', 'application/pdf']]) => {
  let r = request(app).post('/api/company-file/documents').set(bearer(owner.token));
  for (const [k, v] of Object.entries(fields)) r = r.field(k, String(v));
  for (const [buf, filename, contentType] of files) r = r.attach('files', buf, { filename, contentType });
  return r;
};

const slotOf = (file, slot, siteId = null) =>
  file.groups.flatMap((g) => g.slots).find((s) => s.slot === slot && (siteId ? s.site_id === String(siteId) : true));
const slotIds = (file) => file.groups.flatMap((g) => g.slots).map((s) => s.slot);

describe('the rules', () => {
  it('link only to catalogue services that exist', () => {
    for (const r of RULES) if (r.service_id) expect([r.slot, Boolean(getService(r.service_id))]).toEqual([r.slot, true]);
  });

  it('and every catalogue entry that fills a slot names a real one', () => {
    const { SERVICES } = require('../config/serviceCatalogue');
    for (const s of SERVICES) if (s.fills_slot) expect([s.id, Boolean(getRule(s.fills_slot))]).toEqual([s.id, true]);
  });

  it('give every slot a basis a reviewer can check', () => {
    for (const r of RULES) expect([r.slot, r.basis.length > 5]).toEqual([r.slot, true]);
  });
});

describe('working out the company file (pure)', () => {
  const now = new Date('2026-11-15T06:00:00Z');
  const rule = getRule('labour.licence');
  const doc = (expires) => ({ expires_on: expires ? new Date(`${expires}T00:00:00Z`) : null, createdAt: now });

  it('reads slot states from expiry dates, in India days', () => {
    expect(slotStatus(rule, [], false, now)).toBe('missing');
    expect(slotStatus(rule, [doc('2027-06-01')], false, now)).toBe('in_place');
    expect(slotStatus(rule, [doc('2026-12-15')], false, now)).toBe('expiring');   // 30 days
    expect(slotStatus(rule, [doc('2026-12-16')], false, now)).toBe('in_place');   // 31 days
    expect(slotStatus(rule, [doc('2026-11-15')], false, now)).toBe('expiring');   // today
    expect(slotStatus(rule, [doc('2026-11-14')], false, now)).toBe('expired');
    expect(slotStatus(rule, [doc(null)], false, now)).toBe('in_place');
    expect(slotStatus(rule, [doc('2026-11-14')], true, now)).toBe('not_needed');
    expect(daysUntil(new Date('2026-11-16T00:00:00Z'), new Date('2026-11-15T20:00:00Z'))).toBe(0); // already the 16th in India
  });

  it('shows a 12-worker firm different slots from a 60-worker one', () => {
    const base = { own_workers: 2, vehicles: 0, entity_type: 'proprietorship', client_types: ['private'], work_types: ['building'], state: 'DL' };
    const small = buildCompanyFile({ ...base, contract_workers: 10 }, [], [], now);
    expect(slotIds(small)).toEqual(expect.arrayContaining(['labour.bocw', 'labour.esi', 'insurance.wc_policy']));
    expect(slotIds(small)).not.toContain('labour.licence');
    expect(slotIds(small)).not.toContain('labour.pf');
    expect(slotIds(small)).not.toContain('tax.professional_tax');    // not levied in Delhi
    expect(slotIds(small)).not.toContain('company.constitution');    // a proprietorship
    expect(small.questions).toEqual([]);

    const big = buildCompanyFile({ ...base, contract_workers: 58 }, [], [], now);
    expect(slotIds(big)).toEqual(expect.arrayContaining(['labour.licence', 'labour.pf']));
  });

  it('asks rather than guesses when the profile does not say', () => {
    const file = buildCompanyFile({}, [], [], now);
    expect(file.questions).toEqual(expect.arrayContaining(['entity_type', 'client_types', 'work_types', 'state', 'own_workers', 'contract_workers', 'vehicles']));
    expect(slotIds(file)).toEqual(expect.arrayContaining(['company.pan', 'tax.gst_registration', 'tax.itr']));
    expect(slotIds(file)).not.toContain('labour.bocw');
  });

  it('lists site insurance once per site, and vehicle papers only with vehicles', () => {
    const sites = [{ _id: 'a1', name: 'Sector 62' }, { _id: 'b2', name: 'Dwarka' }];
    const file = buildCompanyFile({ vehicles: 3 }, sites, [], now);
    const policies = file.groups.find((g) => g.id === 'sites').slots;
    expect(policies.map((s) => s.site_name)).toEqual(['Sector 62', 'Dwarka']);
    expect(slotIds(file)).toContain('vehicles.puc');
    expect(slotIds(buildCompanyFile({ vehicles: 0 }, sites, [], now))).not.toContain('vehicles.puc');
  });
});

describe('the company file API', () => {
  it('starts empty, with every applicable slot missing and a score of nothing ready', async () => {
    const { owner } = await createWorld();
    await setProfile(owner, { own_workers: 2, contract_workers: 10, vehicles: 0, entity_type: 'proprietorship', client_types: ['private'], work_types: ['building'], state: 'DL' });
    const res = await request(app).get('/api/company-file').set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data.score.ready).toBe(0);
    expect(res.body.data.score.total).toBeGreaterThan(5);
    expect(res.body.data.counts.missing).toBe(res.body.data.score.total);
    expect(slotOf(res.body.data, 'labour.bocw').service_live).toBe(true);
    expect(slotOf(res.body.data, 'insurance.wc_policy').service_live).toBe(false);   // interest only
  });

  it('takes a PDF and a photo, gives back exactly the bytes, and moves the score', async () => {
    const { owner } = await createWorld();
    const bytes = pdf(9000);
    const up = await uploadDoc(owner, { slot: 'company.pan', number: 'AAPFU0939F' }, [[bytes, 'pan.pdf', 'application/pdf'], [jpeg(), 'back.jpg', 'image/jpeg']]);
    expect(up.status).toBe(201);
    expect(up.body.data.title).toBe('PAN card');
    expect(up.body.data.files.map((f) => f.content_type)).toEqual(['application/pdf', 'image/jpeg']);
    expect(up.body.data.files[0]).not.toHaveProperty('key');

    const file = await request(app).get(`/api/company-file/documents/${up.body.data.id}/file/0`)
      .set(bearer(owner.token)).buffer(true).parse(binaryParser);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toMatch(/filename="pan-card-1\.pdf"/);
    expect(file.headers['cache-control']).toMatch(/no-store/);
    expect(file.body.equals(bytes)).toBe(true);

    const cf = (await request(app).get('/api/company-file').set(bearer(owner.token))).body.data;
    expect(slotOf(cf, 'company.pan').status).toBe('in_place');
    expect(cf.score.ready).toBe(1);
  });

  it('takes the type from the bytes: an HTML page called a PDF is refused', async () => {
    const { owner } = await createWorld();
    const res = await uploadDoc(owner, { slot: 'company.pan' }, [[Buffer.from('<html><script>alert(1)</script></html>'), 'pan.pdf', 'application/pdf']]);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Only PDF, JPEG, PNG and WebP/);
    expect(await CompanyDocument.countDocuments()).toBe(0);
  });

  it('refuses a file over 10 MB', async () => {
    const { owner } = await createWorld();
    const res = await uploadDoc(owner, { slot: 'company.pan' }, [[pdf(10 * 1024 * 1024 + 1), 'big.pdf', 'application/pdf']]);
    expect(res.status).toBe(413);
  });

  it('refuses no file, an unknown slot, and an unnamed other document', async () => {
    const { owner } = await createWorld();
    expect((await uploadDoc(owner, { slot: 'company.pan' }, [])).status).toBe(400);
    expect((await uploadDoc(owner, { slot: 'company.spaceship' })).status).toBe(400);
    const other = await uploadDoc(owner, { slot: 'other' });
    expect(other.status).toBe(400);
    expect(other.body.message).toMatch(/name/);
    const named = await uploadDoc(owner, { slot: 'other', title: 'Work order, Sector 62' });
    expect(named.status).toBe(201);
    const cf = (await request(app).get('/api/company-file').set(bearer(owner.token))).body.data;
    expect(cf.other.map((d) => d.title)).toEqual(['Work order, Sector 62']);
  });

  it('shows expiring and expired from the dates given', async () => {
    const { owner } = await createWorld();
    await setProfile(owner, { own_workers: 0, contract_workers: 60 });
    await uploadDoc(owner, { slot: 'labour.licence', expires_on: isoDay(20) });
    await uploadDoc(owner, { slot: 'insurance.wc_policy', expires_on: isoDay(-2) });
    const cf = (await request(app).get('/api/company-file').set(bearer(owner.token))).body.data;
    expect(slotOf(cf, 'labour.licence').status).toBe('expiring');
    expect(slotOf(cf, 'labour.licence').days_left).toBe(20);
    expect(slotOf(cf, 'insurance.wc_policy').status).toBe('expired');
    expect(cf.counts.expiring).toBe(1);
    expect(cf.counts.expired).toBe(1);
    // Expiring is still in place; expired is not.
    expect(cf.score.ready).toBe(1);
  });

  it('refuses an expiry before the issue date, and a date that is not one', async () => {
    const { owner } = await createWorld();
    expect((await uploadDoc(owner, { slot: 'labour.licence', issued_on: '2026-05-01', expires_on: '2026-04-01' })).status).toBe(400);
    expect((await uploadDoc(owner, { slot: 'labour.licence', expires_on: '31/12/2026' })).status).toBe(400);
  });

  it('replaces the paper in a single-paper slot, and keeps several in a multiple one', async () => {
    const { owner } = await createWorld();
    await uploadDoc(owner, { slot: 'company.pan', number: 'OLD' });
    await uploadDoc(owner, { slot: 'company.pan', number: 'NEW' });
    await uploadDoc(owner, { slot: 'tax.itr', title: 'ITR 2024-25' });
    await uploadDoc(owner, { slot: 'tax.itr', title: 'ITR 2023-24' });
    const cf = (await request(app).get('/api/company-file').set(bearer(owner.token))).body.data;
    expect(slotOf(cf, 'company.pan').documents.map((d) => d.number)).toEqual(['NEW']);
    expect(slotOf(cf, 'tax.itr').documents).toHaveLength(2);
    expect(await CompanyDocument.countDocuments({ slot: 'company.pan', status: 'replaced' })).toBe(1);
  });

  it('keeps site insurance per site, and needs the site', async () => {
    const { owner, org, site } = await createWorld();
    const second = await createSite(org, 'Site B');
    expect((await uploadDoc(owner, { slot: 'sites.site_policy' })).status).toBe(400);
    expect((await uploadDoc(owner, { slot: 'sites.site_policy', site_id: String(site._id), expires_on: isoDay(200) })).status).toBe(201);
    const cf = (await request(app).get('/api/company-file').set(bearer(owner.token))).body.data;
    expect(slotOf(cf, 'sites.site_policy', site._id).status).toBe('in_place');
    expect(slotOf(cf, 'sites.site_policy', second._id).status).toBe('missing');
  });

  it('takes a slot out of the score when marked not needed, and puts it back', async () => {
    const { owner } = await createWorld();
    const before = (await request(app).get('/api/company-file').set(bearer(owner.token))).body.data.score.total;
    const mark = await request(app).post('/api/company-file/slots/company.udyam/not-needed').set(bearer(owner.token)).send({ not_needed: true });
    expect(mark.status).toBe(200);
    // Twice is the same as once.
    await request(app).post('/api/company-file/slots/company.udyam/not-needed').set(bearer(owner.token)).send({ not_needed: true });
    let cf = (await request(app).get('/api/company-file').set(bearer(owner.token))).body.data;
    expect(slotOf(cf, 'company.udyam').status).toBe('not_needed');
    expect(cf.score.total).toBe(before - 1);

    await request(app).post('/api/company-file/slots/company.udyam/not-needed').set(bearer(owner.token)).send({ not_needed: false });
    cf = (await request(app).get('/api/company-file').set(bearer(owner.token))).body.data;
    expect(slotOf(cf, 'company.udyam').status).toBe('missing');
    expect(cf.score.total).toBe(before);
  });

  it('lifts a not-needed mark when the paper is uploaded after all', async () => {
    const { owner } = await createWorld();
    await request(app).post('/api/company-file/slots/company.udyam/not-needed').set(bearer(owner.token)).send({});
    await uploadDoc(owner, { slot: 'company.udyam' });
    const cf = (await request(app).get('/api/company-file').set(bearer(owner.token))).body.data;
    expect(slotOf(cf, 'company.udyam').status).toBe('in_place');
  });

  it('edits the details, and deleting removes the stored file too', async () => {
    const { owner } = await createWorld();
    const store = storageModule.storage();
    const up = (await uploadDoc(owner, { slot: 'labour.licence', number: 'L-1' })).body.data;
    const edit = await request(app).put(`/api/company-file/documents/${up.id}`).set(bearer(owner.token)).send({ number: 'L-2', expires_on: '2030-01-31' });
    expect(edit.status).toBe(200);
    expect(edit.body.data).toMatchObject({ number: 'L-2', expires_on: '2030-01-31', title: 'Labour licence' });

    const key = (await CompanyDocument.findById(up.id).lean()).files[0].key;
    expect(store._has(key)).toBe(true);
    const del = await request(app).delete(`/api/company-file/documents/${up.id}`).set(bearer(owner.token));
    expect(del.status).toBe(200);
    expect(store._has(key)).toBe(false);
    expect(await CompanyDocument.countDocuments()).toBe(0);
    const actions = (await AuditLog.find({ entity: 'company_document' }).lean()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['company_document.upload', 'company_document.update', 'company_document.delete']));
  });

  it('answers 503, and stores nothing, when storage is not set up', async () => {
    const { owner } = await createWorld();
    const real = storageModule.storage();
    storageModule._setStorage(storageModule.createStorage({ NODE_ENV: 'production' }));
    try {
      const res = await uploadDoc(owner, { slot: 'company.pan' });
      expect(res.status).toBe(503);
      expect(res.body.message).toMatch(/not set up/);
      expect(await CompanyDocument.countDocuments()).toBe(0);
      // The rest of the company file still works.
      expect((await request(app).get('/api/company-file').set(bearer(owner.token))).status).toBe(200);
    } finally {
      storageModule._setStorage(real);
    }
  });

  it('is refused to a manager', async () => {
    const { manager } = await createWorld();
    expect((await request(app).get('/api/company-file').set(bearer(manager.token))).status).toBe(403);
    expect((await uploadDoc(manager, { slot: 'company.pan' })).status).toBe(403);
  });
});

describe('company file isolation', () => {
  it("never lists, serves, edits or deletes another organisation's document", async () => {
    const a = await createWorld();
    const b = await createWorld();
    const theirs = (await uploadDoc(b.owner, { slot: 'company.pan', number: 'SECRET' })).body.data;

    const cf = (await request(app).get('/api/company-file').set(bearer(a.owner.token))).body.data;
    expect(JSON.stringify(cf)).not.toContain('SECRET');
    for (const [method, path] of [
      ['get', `/api/company-file/documents/${theirs.id}/file/0`],
      ['put', `/api/company-file/documents/${theirs.id}`],
      ['delete', `/api/company-file/documents/${theirs.id}`],
    ]) {
      const res = await request(app)[method](path).set(bearer(a.owner.token)).send({ number: 'MINE' });
      expect([path, res.status]).toEqual([path, 404]);
    }
    const still = await CompanyDocument.findById(theirs.id).lean();
    expect(still.number).toBe('SECRET');
  });

  it("refuses another organisation's site for a site policy", async () => {
    const a = await createWorld();
    const b = await createWorld();
    const res = await uploadDoc(a.owner, { slot: 'sites.site_policy', site_id: String(b.site._id) });
    expect(res.status).toBe(400);
  });
});
