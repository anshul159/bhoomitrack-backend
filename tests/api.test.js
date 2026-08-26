const request = require('supertest');
const app = require('../server');
const Invite = require('../models/Invite');
const User = require('../models/User');
const Slip = require('../models/Slip');
const { createWorld, createOrg, createOwner, bearer } = require('./helpers/factories');

describe('pagination (ENH-015)', () => {
  // List endpoints used to cap results (500, 200) and return them as though
  // complete, so a busy site silently lost its oldest history.
  async function manySlips(count) {
    const world = await createWorld();
    const rows = Array.from({ length: count }, (_, n) => ({
      site_id: world.site._id,
      site_name: world.site.name,
      manager_id: world.manager.user._id,
      manager_name: 'Test Manager',
      items: [{ material_name: 'Cement', quantity_taken: n + 1, unit: 'bags' }],
      status: 'approved',
      orgId: world.org._id,
    }));
    await Slip.insertMany(rows);
    return world;
  }

  it('reports the total and whether more remain', async () => {
    const { owner, site } = await manySlips(25);

    const res = await request(app).get(`/api/slips/${site.name}?limit=10`).set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(10);
    expect(res.body.page).toMatchObject({ page: 1, limit: 10, total: 25, total_pages: 3, has_more: true });
  });

  it('walks pages without repeating or dropping a record', async () => {
    const { owner, site } = await manySlips(25);

    const seen = new Set();
    for (let page = 1; page <= 3; page++) {
      const res = await request(app).get(`/api/slips/${site.name}?limit=10&page=${page}`).set(bearer(owner.token));
      res.body.data.forEach((s) => seen.add(s.id));
    }
    expect(seen.size).toBe(25);
  });

  it('says has_more is false on the last page', async () => {
    const { owner, site } = await manySlips(25);
    const res = await request(app).get(`/api/slips/${site.name}?limit=10&page=3`).set(bearer(owner.token));
    expect(res.body.data).toHaveLength(5);
    expect(res.body.page.has_more).toBe(false);
  });

  it('caps an absurd limit rather than trusting the caller', async () => {
    const { owner, site } = await manySlips(5);
    const res = await request(app).get(`/api/slips/${site.name}?limit=99999`).set(bearer(owner.token));
    expect(res.body.page.limit).toBe(500);
  });

  it('keeps the old response shape for callers that ignore paging', async () => {
    // Existing app builds read `data` and nothing else; adding `page` alongside
    // must not disturb them.
    const { owner, site } = await manySlips(3);
    const res = await request(app).get(`/api/slips/${site.name}`).set(bearer(owner.token));
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.success).toBe(true);
  });
});

describe('API versioning and force update (ENH-010)', () => {
  it('serves the same routes under /api and /api/v1', async () => {
    const { owner, site } = await createWorld();
    const legacy = await request(app).get(`/api/inventory/${site.name}`).set(bearer(owner.token));
    const versioned = await request(app).get(`/api/v1/inventory/${site.name}`).set(bearer(owner.token));

    expect(legacy.status).toBe(200);
    expect(versioned.status).toBe(200);
    expect(versioned.body.data).toEqual(legacy.body.data);
  });

  it('publishes the minimum supported app version', async () => {
    const res = await request(app).get('/api/version');
    expect(res.status).toBe(200);
    expect(res.body.api_version).toBe('v1');
    expect(res.body).toHaveProperty('min_app_version');
    expect(res.body).toHaveProperty('store_url');
  });

  it('turns away a build below the minimum with 426', async () => {
    const { owner, site } = await createWorld();
    process.env.MIN_APP_VERSION = '5';
    try {
      const stale = await request(app).get(`/api/inventory/${site.name}`)
        .set(bearer(owner.token)).set('X-App-Version', '4');
      expect(stale.status).toBe(426);
      expect(stale.body.code).toBe('update_required');
      expect(stale.body.min_version).toBe(5);

      const current = await request(app).get(`/api/inventory/${site.name}`)
        .set(bearer(owner.token)).set('X-App-Version', '5');
      expect(current.status).toBe(200);

      // Builds predating the header must keep working, or the gate becomes the
      // outage it exists to prevent.
      const legacy = await request(app).get(`/api/inventory/${site.name}`).set(bearer(owner.token));
      expect(legacy.status).toBe(200);
    } finally {
      delete process.env.MIN_APP_VERSION;
    }
  });
});

describe('health checks (ENH-004)', () => {
  it('reports the database connection, not merely that it is listening', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('connected');
    expect(res.body).toHaveProperty('uptime_seconds');
  });
});

describe('invite registration', () => {
  it('creates an approved manager who is not yet assigned a site', async () => {
    const org = await createOrg();
    const owner = await createOwner(org);
    const gen = await request(app).post('/api/invite/generate').set(bearer(owner.token)).send({});
    expect(gen.status).toBe(200);

    const res = await request(app).post('/api/invite/register').send({
      code: gen.body.code, name: 'New Manager', phone: '9876500001', password: 'Str0ngPassw0rd!',
    });

    expect(res.status).toBe(200);
    expect(res.body.user.approved).toBe(true);
    expect(res.body.user.site_name).toBe('');
  });

  it('applies the password policy to invite registration', async () => {
    const org = await createOrg();
    const owner = await createOwner(org);
    const gen = await request(app).post('/api/invite/generate').set(bearer(owner.token)).send({});

    const res = await request(app).post('/api/invite/register').send({
      code: gen.body.code, name: 'Weak Manager', phone: '9876500002', password: '123456',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least 8/);
  });

  it('refuses an expired invite code', async () => {
    const org = await createOrg();
    const owner = await createOwner(org);
    const gen = await request(app).post('/api/invite/generate').set(bearer(owner.token)).send({});
    await Invite.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });

    const res = await request(app).post('/api/invite/register').send({
      code: gen.body.code, name: 'Late Manager', phone: '9876500003', password: 'Str0ngPassw0rd!',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid or expired/);
  });

  it('reuses an existing valid code rather than silently invalidating it', async () => {
    const org = await createOrg();
    const owner = await createOwner(org);
    const first = await request(app).post('/api/invite/generate').set(bearer(owner.token)).send({});
    const second = await request(app).post('/api/invite/generate').set(bearer(owner.token)).send({});
    expect(second.body.code).toBe(first.body.code);

    const forced = await request(app).post('/api/invite/generate').set(bearer(owner.token)).send({ force: true });
    expect(forced.body.code).not.toBe(first.body.code);
  });
});

describe('site assignment (ENH-016)', () => {
  it('replaces assignments with the singular form, preserving old behaviour', async () => {
    const { org, owner, site, manager } = await createWorld();
    const { createSite } = require('./helpers/factories');
    const second = await createSite(org, 'Site B');

    await request(app).put(`/api/users/assign-site/${manager.user._id}`)
      .set(bearer(owner.token)).send({ siteName: second.name });

    const stored = await User.findById(manager.user._id);
    expect(stored.site_ids.map(String)).toEqual([String(second._id)]);
    expect(stored.site_name).toBe('Site B');
    expect(String(site._id)).not.toBe(String(second._id));
  });

  it('adds a second site when asked to', async () => {
    const { org, owner, site, manager } = await createWorld();
    const { createSite } = require('./helpers/factories');
    const second = await createSite(org, 'Site B');

    await request(app).put(`/api/users/assign-site/${manager.user._id}`)
      .set(bearer(owner.token)).send({ siteName: second.name, add: true });

    const stored = await User.findById(manager.user._id);
    expect(stored.site_ids.map(String).sort()).toEqual([String(site._id), String(second._id)].sort());
  });

  it('removes one site while leaving the rest', async () => {
    const { org, owner, site, manager } = await createWorld();
    const { createSite } = require('./helpers/factories');
    const second = await createSite(org, 'Site B');

    await request(app).put(`/api/users/assign-site/${manager.user._id}`)
      .set(bearer(owner.token)).send({ siteNames: [site.name, second.name] });
    await request(app).put(`/api/users/remove-from-site/${manager.user._id}`)
      .set(bearer(owner.token)).send({ siteName: site.name });

    const stored = await User.findById(manager.user._id);
    expect(stored.site_ids.map(String)).toEqual([String(second._id)]);
    expect(stored.site_name).toBe('Site B');
  });

  it('refuses a site that does not exist', async () => {
    const { owner, manager } = await createWorld();
    const res = await request(app).put(`/api/users/assign-site/${manager.user._id}`)
      .set(bearer(owner.token)).send({ siteName: 'Nowhere' });
    expect(res.status).toBe(404);
  });
});
