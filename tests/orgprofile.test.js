const request = require('supertest');
const app = require('../server');
const Organization = require('../models/Organization');
const AuditLog = require('../models/AuditLog');
const { isGstin, isPan } = require('../utils/validate');
const { createWorld, bearer } = require('./helpers/factories');

// The organisation profile (BhoomiTrack Services, phase 0): asked late, one field
// at a time, and the basis for which company-file slots apply.

const GSTIN = '27AAPFU0939F1ZV';          // a widely published valid example

describe('GSTIN and PAN checks', () => {
  it('accepts a real GSTIN and catches a single mistyped character', () => {
    expect(isGstin(GSTIN)).toBe(true);
    expect(isGstin('27AAPFU0939F1ZW')).toBe(false);     // wrong check character
    expect(isGstin('27AAPFU0939F1ZV '.trim())).toBe(true);
    expect(isGstin('27AAPFU0939F1Z')).toBe(false);      // too short
    expect(isGstin('00AAPFU0939F1ZV')).toBe(false);     // no state 00
    expect(isGstin('27aapfu0939f1zv')).toBe(false);     // cleaned before checking, not here
  });

  it('accepts a PAN in its fixed shape only', () => {
    expect(isPan('AAPFU0939F')).toBe(true);
    expect(isPan('ABCPE1234F')).toBe(true);
    expect(isPan('ABCXE1234F')).toBe(false);            // X is not a holder type
    expect(isPan('ABCDE12345')).toBe(false);
  });
});

describe('PUT /api/org/settings with a profile', () => {
  it('saves a partial profile, cleaned, and GET /api/org returns it to the owner', async () => {
    const { owner } = await createWorld();
    const res = await request(app).put('/api/org/settings').set(bearer(owner.token))
      .send({ profile: { gstin: ' 27aapfu0939f1zv ', state: 'dl', contract_workers: 12, work_types: ['building', 'building'] } });
    expect(res.status).toBe(200);
    expect(res.body.data.profile).toMatchObject({
      gstin: GSTIN, state: 'DL', state_name: 'Delhi', contract_workers: 12, work_types: ['building'],
      pan: 'AAPFU0939F',          // read out of the GSTIN, never asked twice
      entity_type: null, own_workers: null, client_types: [],
    });

    const got = await request(app).get('/api/org').set(bearer(owner.token));
    expect(got.body.data.profile.gstin).toBe(GSTIN);
    expect(got.body.data.name).toBeTruthy();
  });

  it('touches only the fields sent, and null clears one', async () => {
    const { owner, org } = await createWorld();
    await request(app).put('/api/org/settings').set(bearer(owner.token))
      .send({ profile: { state: 'UP', own_workers: 4, client_types: ['government'] } });
    const res = await request(app).put('/api/org/settings').set(bearer(owner.token))
      .send({ profile: { own_workers: null, district: 'Noida' } });
    expect(res.status).toBe(200);
    expect(res.body.data.profile).toMatchObject({ state: 'UP', own_workers: null, district: 'Noida', client_types: ['government'] });

    const saved = await Organization.findById(org._id).lean();
    expect(saved.profile.own_workers).toBeNull();
    expect(saved.name).toBe(org.name);      // the name was not part of this write
  });

  it('refuses the whole write when one field is wrong, and says which', async () => {
    const { owner, org } = await createWorld();
    const res = await request(app).put('/api/org/settings').set(bearer(owner.token))
      .send({ name: 'Renamed', profile: { state: 'DL', gstin: '27AAPFU0939F1ZW' } });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('gstin');
    const saved = await Organization.findById(org._id).lean();
    expect(saved.name).toBe(org.name);
    expect(saved.profile?.state ?? null).toBeNull();
  });

  it.each([
    [{ pan: 'ABCDE12345' }, 'pan'],
    [{ state: 'XX' }, 'state'],
    [{ contract_workers: -1 }, 'contract_workers'],
    [{ contract_workers: 2.5 }, 'contract_workers'],
    [{ own_workers: '12' }, 'own_workers'],
    [{ entity_type: 'trust_fund' }, 'entity_type'],
    [{ work_types: ['space'] }, 'work_types'],
    [{ client_types: 'government' }, 'client_types'],
    [{ udyam_no: 'UDYAM-123' }, 'udyam_no'],
    [{ turnover_band: 'huge' }, 'turnover_band'],
  ])('refuses %j', async (profile, field) => {
    const { owner } = await createWorld();
    const res = await request(app).put('/api/org/settings').set(bearer(owner.token)).send({ profile });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe(field);
  });

  it('refuses a PAN that disagrees with the PAN inside the GSTIN', async () => {
    const { owner } = await createWorld();
    const res = await request(app).put('/api/org/settings').set(bearer(owner.token))
      .send({ profile: { gstin: GSTIN, pan: 'ABCPE1234F' } });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('pan');
  });

  it('accepts a Udyam number and a type of business', async () => {
    const { owner } = await createWorld();
    const res = await request(app).put('/api/org/settings').set(bearer(owner.token))
      .send({ profile: { udyam_no: 'udyam-dl-01-0012345', entity_type: 'proprietorship', turnover_band: '1cr_5cr' } });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.udyam_no).toBe('UDYAM-DL-01-0012345');
  });

  it('audits what changed in the profile', async () => {
    const { owner, org } = await createWorld();
    await request(app).put('/api/org/settings').set(bearer(owner.token)).send({ profile: { state: 'DL' } });
    let row;
    const end = Date.now() + 3000;
    while (!(row = await AuditLog.findOne({ orgId: org._id, action: 'org.update' }).lean()) && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(row.after.profile).toEqual({ state: 'DL', state_name: 'Delhi' });
  });

  it('refuses a manager, and never shows a manager the profile', async () => {
    const { manager, owner } = await createWorld();
    await request(app).put('/api/org/settings').set(bearer(owner.token)).send({ profile: { gstin: GSTIN } });

    const put = await request(app).put('/api/org/settings').set(bearer(manager.token)).send({ profile: { state: 'DL' } });
    expect(put.status).toBe(403);
    const got = await request(app).get('/api/org').set(bearer(manager.token));
    expect(got.status).toBe(200);
    expect(got.body.data).not.toHaveProperty('profile');
  });

  it("keeps one organisation's profile out of another's", async () => {
    const a = await createWorld();
    const b = await createWorld();
    await request(app).put('/api/org/settings').set(bearer(a.owner.token)).send({ profile: { gstin: GSTIN } });
    const got = await request(app).get('/api/org').set(bearer(b.owner.token));
    expect(got.body.data.profile.gstin).toBeNull();
  });
});
