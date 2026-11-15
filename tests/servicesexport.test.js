const request = require('supertest');
const app = require('../server');
const CompanyDocument = require('../models/CompanyDocument');
const ServiceRequest = require('../models/ServiceRequest');
const storageModule = require('../utils/storage');
const { createWorld, bearer } = require('./helpers/factories');

// The company file and service requests leave with the customer and go when the
// organisation goes (BhoomiTrack Services, plan §6.3 "Export and deletion").

const pdf = () => { const b = Buffer.alloc(2048, 0x20); b.write('%PDF-1.4\n', 0, 'latin1'); return b; };
const upload = (owner, slot = 'company.pan') => request(app).post('/api/company-file/documents').set(bearer(owner.token))
  .field('slot', slot).attach('files', pdf(), { filename: 'a.pdf', contentType: 'application/pdf' });
const readExport = (token) => request(app).get('/api/org/export').set(bearer(token)).buffer(true)
  .parse((r, cb) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => cb(null, d)); });

describe('export and deletion of the company file and service requests', () => {
  it('exports every paper with a file manifest, every request, and the profile', async () => {
    const { owner } = await createWorld();
    await request(app).put('/api/org/settings').set(bearer(owner.token)).send({ profile: { state: 'DL' } });
    const doc = (await upload(owner)).body.data;
    await request(app).post('/api/company-file/slots/company.udyam/not-needed').set(bearer(owner.token)).send({});
    await request(app).post('/api/services/requests').set(bearer(owner.token))
      .send({ service_id: 'experts.ca', consent: true, details: { question: 'Notice under section 143' } });

    const body = JSON.parse((await readExport(owner.token)).body);
    expect(body.organization.profile.state).toBe('DL');
    expect(body.counts).toMatchObject({ company_documents: 1, service_requests: 1 });
    expect(body.company_documents).toHaveLength(1);           // the not-needed mark is not a paper
    const files = body.company_documents[0].files;
    expect(files).toEqual([{ n: 0, content_type: 'application/pdf', size: 2048, path: `/api/company-file/documents/${doc.id}/file/0` }]);
    expect(JSON.stringify(body.company_documents)).not.toMatch(/"key"/);   // storage keys stay ours
    expect(body.service_requests[0].details.question).toBe('Notice under section 143');
    expect(body.service_requests[0].consent.shares.length).toBeGreaterThan(0);
  });

  it('deletes the stored files, the papers and the requests with the organisation', async () => {
    const { org, owner } = await createWorld();
    const other = await createWorld();
    await upload(owner);
    await upload(owner, 'tax.itr');
    const kept = (await upload(other.owner)).body.data;
    await request(app).post('/api/services/requests').set(bearer(owner.token)).send({ service_id: 'insurance.group_health' });
    const store = storageModule.storage();
    const before = store._size();

    const res = await request(app).delete('/api/org').set(bearer(owner.token)).send({ confirmName: org.name });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ company_files: 2, company_documents: 2, service_requests: 1 });
    expect(store._size()).toBe(before - 2);
    expect(await CompanyDocument.countDocuments({ orgId: org._id })).toBe(0);
    expect(await ServiceRequest.countDocuments({ orgId: org._id })).toBe(0);
    // Another organisation's papers are untouched.
    const theirs = await CompanyDocument.findById(kept.id).lean();
    expect(store._has(theirs.files[0].key)).toBe(true);
  });

  it('deletes nothing when storage cannot delete the files', async () => {
    const { org, owner } = await createWorld();
    await upload(owner);
    const real = storageModule.storage();
    storageModule._setStorage({ ...real, name: 'flaky', delete: async () => { throw new Error('R2 down'); } });
    try {
      const res = await request(app).delete('/api/org').set(bearer(owner.token)).send({ confirmName: org.name });
      expect(res.status).toBe(503);
      expect(await CompanyDocument.countDocuments({ orgId: org._id })).toBe(1);
    } finally {
      storageModule._setStorage(real);
    }
  });

  it('carries a site rename onto service requests', async () => {
    const { owner, site } = await createWorld();
    await request(app).post('/api/services/requests').set(bearer(owner.token)).send({
      service_id: 'materials.quote', consent: true,
      details: { site_id: String(site._id), material: 'Sand', quantity: 2, unit: 'Brass' },
    });
    await request(app).put(`/api/sites/rename/${site._id}`).set(bearer(owner.token)).send({ name: 'Tower 2' });
    expect((await ServiceRequest.findOne().lean()).site_name).toBe('Tower 2');
  });
});
