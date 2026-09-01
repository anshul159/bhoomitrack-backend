const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../server');
const { createWorld, createInventory, bearer } = require('./helpers/factories');

/**
 * The two platform-level findings fixed for the 1.2.2 release freeze.
 *
 * Both were found by the performance pass and both are the same kind of defect:
 * the code states an intention in a comment that the implementation does not
 * achieve. Pinned here because neither shows up in a functional test — the API
 * returns the right JSON either way.
 */
describe('platform', () => {

  // ─── PF-008 ────────────────────────────────────────────────────────────────
  describe('PF-008 — /healthz probes the database rather than the socket', () => {

    it('reports ok, and its version comes from package.json', async () => {
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.database).toBe('connected');
      expect(res.body.version).toBe(require('../package.json').version);
    });

    it('reports degraded when the database answers the socket but not a ping', async () => {
      // The PF-008 outage exactly: readyState stays 1 because the socket is open,
      // while a real command never comes back. Before the fix this returned
      // 200 {"status":"ok","database":"connected"} throughout.
      expect(mongoose.connection.readyState).toBe(1);

      const admin = mongoose.connection.db.admin;
      mongoose.connection.db.admin = () => ({
        ping: () => new Promise(() => {}),          // never settles
      });

      try {
        const res = await request(app).get('/healthz');
        expect(res.status).toBe(503);
        expect(res.body.success).toBe(false);
        expect(res.body.status).toBe('degraded');
        expect(res.body.database).toBe('unresponsive');
      } finally {
        mongoose.connection.db.admin = admin;
      }
    });

    it('recovers once the database answers again', async () => {
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body.database).toBe('connected');
    });
  });

  // ─── PF-005 ────────────────────────────────────────────────────────────────
  describe('PF-005 — responses are compressed', () => {

    it('gzips a response large enough to be worth it', async () => {
      const world = await createWorld();

      // compression() has a 1 KB threshold, so the payload has to be real.
      for (let i = 0; i < 60; i++) {
        await createInventory(world.org, world.site, {
          name: `Material number ${i} with a deliberately long name`,
        });
      }

      const res = await request(app)
        .get(`/api/inventory/${encodeURIComponent(world.site.name)}`)
        .set(bearer(world.owner.token))
        .set('Accept-Encoding', 'gzip');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe('gzip');

      // And it is still the JSON the client expects once decoded — superagent
      // gunzips it for us, which is exactly what the Android client's HTTP stack
      // does too.
      expect(res.body.success).toBe(true);
    });
  });
});
