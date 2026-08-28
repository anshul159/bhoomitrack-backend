const request = require('supertest');
const app = require('../server');
const User = require('../models/User');
const { createWorld, PASSWORD, bearer } = require('./helpers/factories');
const { AVATAR_MAX_CHARS } = require('../utils/validate');

// A 1x1 JPEG is enough: these tests are about the contract around the bytes, not
// about the bytes. Anything that decodes to a real image would test Sharp, which
// is not in this stack.
const TINY_JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

describe('profile picture', () => {
  let world;
  beforeEach(async () => { world = await createWorld(); });

  it('stores a picture and hands it back', async () => {
    const res = await request(app)
      .put('/api/users/me/avatar')
      .set(bearer(world.owner.token))
      .send({ avatar: TINY_JPEG });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.avatar).toBe(TINY_JPEG);

    const stored = await User.findById(world.owner.user._id).select('+avatar').lean();
    expect(stored.avatar).toBe(TINY_JPEG);
  });

  it('returns the picture from /me', async () => {
    await request(app).put('/api/users/me/avatar').set(bearer(world.owner.token)).send({ avatar: TINY_JPEG });

    const res = await request(app).get('/api/users/me').set(bearer(world.owner.token));
    expect(res.status).toBe(200);
    expect(res.body.user.avatar).toBe(TINY_JPEG);
  });

  // The whole point of setting it at sign-in is that the picture is on screen
  // from the first frame rather than after a second round trip.
  it('returns the picture on login', async () => {
    await request(app).put('/api/users/me/avatar').set(bearer(world.owner.token)).send({ avatar: TINY_JPEG });

    const res = await request(app)
      .post('/api/users/login')
      .send({ email: world.owner.user.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user.avatar).toBe(TINY_JPEG);
  });

  it('returns an empty string, never undefined, when none is set', async () => {
    const res = await request(app).get('/api/users/me').set(bearer(world.owner.token));
    expect(res.body.user.avatar).toBe('');
  });

  it('removes a picture', async () => {
    await request(app).put('/api/users/me/avatar').set(bearer(world.owner.token)).send({ avatar: TINY_JPEG });

    const res = await request(app).delete('/api/users/me/avatar').set(bearer(world.owner.token));
    expect(res.status).toBe(200);
    expect(res.body.avatar).toBe('');

    const stored = await User.findById(world.owner.user._id).select('+avatar').lean();
    expect(stored.avatar).toBe('');
  });

  // Removing something already absent satisfies the caller's intent, so it is a
  // success rather than a 404 the client would have to special-case.
  it('removing an absent picture succeeds', async () => {
    const res = await request(app).delete('/api/users/me/avatar').set(bearer(world.owner.token));
    expect(res.status).toBe(200);
  });

  it('works for a manager as well as an owner', async () => {
    const res = await request(app)
      .put('/api/users/me/avatar')
      .set(bearer(world.manager.token))
      .send({ avatar: TINY_JPEG });
    expect(res.status).toBe(200);
  });

  describe('refuses what it should', () => {
    const reject = (avatar) =>
      request(app).put('/api/users/me/avatar').set(bearer(world.owner.token)).send({ avatar });

    it('an http URL rather than image data', async () => {
      expect((await reject('https://example.com/me.jpg')).status).toBe(400);
    });

    // Not pedantry: an inline SVG is a script-execution vector wherever it is
    // later rendered, and it is the one "image" format that carries code.
    it('an SVG', async () => {
      expect((await reject('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).status).toBe(400);
    });

    it('a non-image data URI', async () => {
      expect((await reject('data:text/html;base64,PGgxPmhpPC9oMT4=')).status).toBe(400);
    });

    it('raw text', async () => {
      expect((await reject('hello')).status).toBe(400);
    });

    it('a missing field', async () => {
      expect((await reject(undefined)).status).toBe(400);
    });

    it('a non-string', async () => {
      expect((await reject({ nested: 'object' })).status).toBe(400);
    });

    // The device downscales before sending, but the server cannot take that on
    // trust — an unbounded field on the user document is a slow outage.
    it('an image past the size cap', async () => {
      const huge = 'data:image/png;base64,' + 'A'.repeat(AVATAR_MAX_CHARS);
      const res = await reject(huge);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/KB/);
    });

    it('an unauthenticated caller', async () => {
      const res = await request(app).put('/api/users/me/avatar').send({ avatar: TINY_JPEG });
      expect(res.status).toBe(401);
    });
  });

  // select:false is the guard that keeps images out of the list endpoints, which
  // are already the largest responses in the product (PF-005). If someone removes
  // it, this fails.
  it('does not leak into the managers list', async () => {
    await request(app).put('/api/users/me/avatar').set(bearer(world.manager.token)).send({ avatar: TINY_JPEG });

    const res = await request(app).get('/api/users/managers').set(bearer(world.owner.token));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('data:image');
  });
});
