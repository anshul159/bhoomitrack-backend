const request = require('supertest');

/**
 * PF-004 and PF-006 — how the limiters are keyed, and what they bound.
 *
 * These need their own app instance because express-rate-limit reads its limits when
 * the middleware is constructed, which happens once when server.js is required. Each
 * block resets the module registry, sets the limits it wants, and re-requires the
 * server. The database connection is shared with the rest of the suite, which is
 * fine — nothing here touches data.
 */
function appWithLimits(env) {
  let app;
  jest.isolateModules(() => {
    const previous = {};
    for (const [k, v] of Object.entries(env)) {
      previous[k] = process.env[k];
      process.env[k] = String(v);
    }
    app = require('../server');
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  return app;
}

describe('rate limiting', () => {

  // ─── PF-006 ────────────────────────────────────────────────────────────────
  describe('PF-006 — a burst is bounded, not just the 15-minute volume', () => {

    it('refuses a burst that is inside the volume cap', async () => {
      // The finding: 600 requests were allowed in any distribution across 15
      // minutes, including all 600 in two seconds. The volume cap here is left
      // generous precisely so that only the burst limiter can be what rejects.
      const app = appWithLimits({ RATE_LIMIT_BURST_MAX: 5, RATE_LIMIT_API_MAX: 10000 });

      const codes = [];
      for (let i = 0; i < 8; i++) {
        const res = await request(app).get('/api/version');
        codes.push(res.status);
      }

      expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(codes.slice(5)).toEqual([429, 429, 429]);
    });

    it('explains itself as a momentary limit, not a 15-minute lockout', async () => {
      const app = appWithLimits({ RATE_LIMIT_BURST_MAX: 1, RATE_LIMIT_API_MAX: 10000 });
      await request(app).get('/api/version');
      const res = await request(app).get('/api/version');

      expect(res.status).toBe(429);
      expect(res.body.message).toMatch(/at once|moment/i);
    });
  });

  // ─── PF-004 ────────────────────────────────────────────────────────────────
  describe('PF-004 — an office does not share one budget', () => {

    // These send an email and no password, which /login rejects with 400 before it
    // queries anything. That keeps the assertions on the limiter's KEYING — which is
    // what PF-004 was about — and off the database, which the isolated module
    // registry above does not have a connection to. An allowed attempt is a 400; a
    // refused one is a 429, and the limiter runs first either way.
    const attempt = (app, email) => request(app).post('/api/users/login').send({ email });

    it('gives two people on one connection separate credential allowances', async () => {
      // Before this fix the whole office shared 25 credential attempts per 15
      // minutes, so a few mistyped passwords locked out colleagues who had not
      // tried at all. Supertest sends everything from one address, which is exactly
      // the shared-office shape.
      const app = appWithLimits({ RATE_LIMIT_AUTH_MAX: 2, RATE_LIMIT_SPRAY_MAX: 10000 });

      expect((await attempt(app, 'alice@example.com')).status).toBe(400);
      expect((await attempt(app, 'alice@example.com')).status).toBe(400);
      expect((await attempt(app, 'alice@example.com')).status).toBe(429);

      // Bob, on the same connection, is unaffected — this is the whole finding.
      expect((await attempt(app, 'bob@example.com')).status).toBe(400);
    });

    it('still stops someone working through passwords for one account', async () => {
      const app = appWithLimits({ RATE_LIMIT_AUTH_MAX: 3, RATE_LIMIT_SPRAY_MAX: 10000 });

      await attempt(app, 'victim@example.com');
      await attempt(app, 'victim@example.com');
      await attempt(app, 'victim@example.com');
      expect((await attempt(app, 'victim@example.com')).status).toBe(429);
    });

    it('still stops one connection spraying many accounts', async () => {
      // Keying by identity alone would let a host try one password against
      // thousands of accounts and never trip a limit. The spray limiter is what
      // makes that not so.
      const app = appWithLimits({ RATE_LIMIT_AUTH_MAX: 1000, RATE_LIMIT_SPRAY_MAX: 4 });

      for (let n = 1; n <= 4; n++) {
        expect((await attempt(app, `target${n}@example.com`)).status).toBe(400);
      }
      expect((await attempt(app, 'target5@example.com')).status).toBe(429);
    });
  });
});
