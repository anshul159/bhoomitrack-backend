const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../server');
const User = require('../models/User');
const Site = require('../models/Site');
const Slip = require('../models/Slip');
const AuditLog = require('../models/AuditLog');
const {
  createWorld, createOrg, createOwner, createSite, createInventory, bearer, PASSWORD,
} = require('./helpers/factories');

/**
 * The findings closed for the 1.3.0 release: PF-001, PF-002, PF-003, PF-004,
 * PF-006, PF-007, PF-009 and PF-010.
 *
 * Every one of these was a race, a missing bound, or a cost that only shows up at a
 * scale the tests do not reach — so each test here is written to fail against the
 * OLD code, not merely to exercise the new code.
 */
describe('findings closed in 1.3.0', () => {

  // Mongoose builds indexes in the background after a model is compiled, so a test
  // that fires 20 concurrent writes immediately can beat the build and see the old
  // behaviour. `init()` waits for it. Production has the same race exactly once, on
  // a brand-new database — once an index is built it is a property of the
  // collection and survives every restart.
  beforeAll(async () => {
    await Promise.all([User.init(), Site.init(), Slip.init()]);
  });

  // ─── PF-001 ────────────────────────────────────────────────────────────────
  describe('PF-001 — one email cannot become many accounts', () => {

    const register = (email) => request(app)
      .post('/api/users/register-company')
      .send({ name: 'Owner', email, password: PASSWORD, companyName: 'Acme Builders' });

    it('refuses a second registration on the same email', async () => {
      const first = await register('race@example.com');
      expect(first.status).toBe(200);

      const second = await register('race@example.com');
      expect(second.status).toBeGreaterThanOrEqual(400);
      expect(second.body.success).toBe(false);
      expect(second.body.message).toMatch(/already exists/i);
    });

    it('creates exactly one account when 20 registrations arrive at once', async () => {
      // The original finding: 20 simultaneous calls produced 20 accounts, 15/15
      // rounds, because the pre-insert lookup is a check-then-write race. Only the
      // unique index closes it.
      const email = 'thundering@example.com';
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => register(email))
      );

      const created = results.filter(
        (r) => r.status === 'fulfilled' && r.value.status === 200
      ).length;
      expect(created).toBe(1);

      const users = await User.find({ email, deletedAt: null });
      expect(users).toHaveLength(1);
    });

    it('does not leave an orphaned organisation behind when it loses the race', async () => {
      // The organisation is created before the user, so a rejected registration
      // must clean it up or every lost race leaks a company.
      const Organization = require('../models/Organization');
      const email = 'orphan@example.com';
      await register(email);
      const before = await Organization.countDocuments({ name: 'Acme Builders' });

      await register(email);                       // loses
      const after = await Organization.countDocuments({ name: 'Acme Builders' });

      expect(after).toBe(before);
    });

    it('lets a deleted account release its address', async () => {
      // The index is partial on deletedAt, so a soft-deleted user must not hold an
      // email hostage forever.
      const email = 'recycled@example.com';
      const first = await register(email);
      expect(first.status).toBe(200);

      await User.updateOne({ email }, { $set: { deletedAt: new Date() } });

      const second = await register(email);
      expect(second.status).toBe(200);
    });
  });

  // ─── PF-002 ────────────────────────────────────────────────────────────────
  describe('PF-002 — one site name cannot become many sites', () => {

    it('creates exactly one site when 15 creates arrive at once', async () => {
      const world = await createWorld();
      const results = await Promise.allSettled(
        Array.from({ length: 15 }, () => request(app)
          .post('/api/sites/create')
          .set(bearer(world.owner.token))
          .send({ name: 'Riverside Towers' }))
      );

      const created = results.filter(
        (r) => r.status === 'fulfilled' && r.value.status === 200
      ).length;
      expect(created).toBe(1);

      const sites = await Site.find({ orgId: world.org._id, name: 'Riverside Towers' });
      expect(sites).toHaveLength(1);
    });

    it('answers the loser with a message, not a 500', async () => {
      const world = await createWorld();
      const create = () => request(app)
        .post('/api/sites/create')
        .set(bearer(world.owner.token))
        .send({ name: 'Second Site' });

      await create();
      const dup = await create();
      expect(dup.status).toBeGreaterThanOrEqual(400);
      expect(dup.status).toBeLessThan(500);
      expect(dup.body.message).toMatch(/already exists/i);
    });

    it('still lets two different organisations use the same site name', async () => {
      const a = await createWorld();
      const b = await createWorld();
      const name = 'Shared Name Between Firms';

      const ra = await request(app).post('/api/sites/create').set(bearer(a.owner.token)).send({ name });
      const rb = await request(app).post('/api/sites/create').set(bearer(b.owner.token)).send({ name });

      expect(ra.status).toBe(200);
      expect(rb.status).toBe(200);
    });
  });

  // ─── PF-003 ────────────────────────────────────────────────────────────────
  describe('PF-003 — five taps do not make five slips', () => {

    const generate = (world, key) => {
      const req = request(app)
        .post('/api/slips/generate')
        .set(bearer(world.manager.token));
      return req.send({
        site_name: world.site.name,
        client_request_id: key,
        items: [{ inventory_id: world.item._id, quantity_taken: 5 }],
      });
    };

    it('creates one slip when the same request id arrives five times at once', async () => {
      const world = await createWorld();
      const key = 'tap-tap-tap-tap-tap';

      const results = await Promise.all(Array.from({ length: 5 }, () => generate(world, key)));
      results.forEach((r) => expect(r.status).toBe(200));

      const slips = await Slip.find({ orgId: world.org._id, client_request_id: key });
      expect(slips).toHaveLength(1);
    });

    it('returns the same slip on a later retry, flagged as a replay', async () => {
      const world = await createWorld();
      const key = 'retry-after-timeout';

      const first = await generate(world, key);
      const second = await generate(world, key);

      expect(second.status).toBe(200);
      expect(second.body.idempotent_replay).toBe(true);
      expect(second.body.data.id).toBe(first.body.data.id);
    });

    it('still creates separate slips for genuinely separate requests', async () => {
      const world = await createWorld();
      await generate(world, 'first-slip');
      await generate(world, 'second-slip');

      const slips = await Slip.find({ orgId: world.org._id });
      expect(slips).toHaveLength(2);
    });

    it('accepts the Idempotency-Key header as well as the body field', async () => {
      const world = await createWorld();
      const send = () => request(app)
        .post('/api/slips/generate')
        .set(bearer(world.manager.token))
        .set('Idempotency-Key', 'via-header')
        .send({ site_name: world.site.name, items: [{ inventory_id: world.item._id, quantity_taken: 1 }] });

      await send();
      const second = await send();
      expect(second.body.idempotent_replay).toBe(true);
    });

    it('leaves an older client with no request id working exactly as before', async () => {
      const world = await createWorld();
      const send = () => request(app)
        .post('/api/slips/generate')
        .set(bearer(world.manager.token))
        .send({ site_name: world.site.name, items: [{ inventory_id: world.item._id, quantity_taken: 1 }] });

      await send();
      await send();
      // Two calls, no key, two slips — the old behaviour, deliberately preserved.
      const slips = await Slip.find({ orgId: world.org._id });
      expect(slips).toHaveLength(2);
    });
  });

  // ─── PF-007 ────────────────────────────────────────────────────────────────
  describe('PF-007 — auth still protects every data route once it runs only once', () => {
    // Removing the per-route `auth` is only safe if the mount-level one covers
    // everything. These are the routes that would silently open if it did not.
    const PROTECTED = [
      ['get', '/api/sites'],
      ['get', '/api/inventory/Anywhere'],
      ['get', '/api/orders'],
      ['get', '/api/slips/pending'],
      ['get', '/api/chat/507f1f77bcf86cd799439011'],
      ['get', '/api/reports/analytics'],
      ['get', '/api/audit'],
      ['get', '/api/org'],
      ['get', '/api/org/export'],
    ];

    it.each(PROTECTED)('rejects an unauthenticated %s %s', async (method, path) => {
      const res = await request(app)[method](path);
      expect(res.status).toBe(401);
    });

    it('still rejects a manager on an owner-only route', async () => {
      const world = await createWorld();
      const res = await request(app).get('/api/sites').set(bearer(world.manager.token));
      expect(res.status).toBe(403);
    });
  });

  // ─── PF-009 ────────────────────────────────────────────────────────────────
  describe('PF-009 — the export streams and stays complete', () => {

    it('returns valid JSON containing every record', async () => {
      const world = await createWorld();
      for (let i = 0; i < 25; i++) {
        await createInventory(world.org, world.site, { name: `Material ${i}` });
      }

      const res = await request(app)
        .get('/api/org/export')
        .set(bearer(world.owner.token))
        .buffer(true)
        .parse((r, cb) => {
          let data = '';
          r.on('data', (c) => { data += c; });
          r.on('end', () => cb(null, data));
        });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);          // streamed JSON must still parse

      // 25 created here plus the one createWorld makes.
      expect(body.inventory).toHaveLength(26);
      expect(body.counts.inventory).toBe(26);
      expect(body.sites).toHaveLength(1);
      expect(body.organization.id).toBe(String(world.org._id));
      expect(Array.isArray(body.slips)).toBe(true);
      expect(Array.isArray(body.audit_log)).toBe(true);
    });

    it('never exports credentials', async () => {
      const world = await createWorld();
      const res = await request(app)
        .get('/api/org/export')
        .set(bearer(world.owner.token))
        .buffer(true)
        .parse((r, cb) => {
          let data = '';
          r.on('data', (c) => { data += c; });
          r.on('end', () => cb(null, data));
        });

      expect(res.body).not.toMatch(/"password"/);
      expect(res.body).not.toMatch(/"otpHash"/);
      expect(res.body).not.toMatch(/"fcmTokens"/);
    });
  });

  // ─── PF-010 ────────────────────────────────────────────────────────────────
  describe('PF-010 — audit logs expire', () => {

    it('declares a TTL index so the collection cannot grow without bound', async () => {
      const indexes = await AuditLog.collection.indexes();
      const ttl = indexes.find((i) => i.name === 'audit_ttl');
      expect(ttl).toBeDefined();
      expect(ttl.expireAfterSeconds).toBeGreaterThan(0);
    });

    it('keeps the window long enough to outlast a dispute', async () => {
      // Three years by default. The rows are evidence about money, so this is a
      // deliberately long retention rather than a storage optimisation.
      expect(AuditLog.RETENTION_DAYS).toBeGreaterThanOrEqual(365);
    });
  });
});
