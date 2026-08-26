const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const User = require('../models/User');
const Organization = require('../models/Organization');
const { makeToken } = require('../utils/token');
const { createWorld, createOrg, createOwner, PASSWORD, bearer } = require('./helpers/factories');

describe('password policy (ENH-018)', () => {
  const attempt = (password, extra = {}) =>
    request(app).post('/api/users/register-company').send({
      companyName: 'Acme Builders',
      name: 'Alice Owner',
      email: 'alice@example.com',
      password,
      ...extra,
    });

  it('rejects a password under eight characters', async () => {
    const res = await attempt('Ab3!x');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least 8/);
  });

  it('rejects an all-numeric password', async () => {
    const res = await attempt('12345678901');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only numbers/);
  });

  it('rejects a well-known password', async () => {
    const res = await attempt('password123');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/too common/);
  });

  it('rejects a password containing the user\'s own name', async () => {
    const res = await attempt('aliceowner99');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/must not contain your name/);
  });

  it('accepts a reasonable password and starts a trial', async () => {
    const res = await attempt('Str0ngPassw0rd!');
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();

    const org = await Organization.findOne({ name: 'Acme Builders' });
    expect(org.status).toBe('trialing');
    expect(org.trialEndsAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('password reset (ENH-001)', () => {
  it('answers identically whether or not the account exists', async () => {
    const org = await createOrg();
    await createOwner(org, { email: 'real@example.com' });

    const known = await request(app).post('/api/users/forgot-password').send({ email: 'real@example.com' });
    const unknown = await request(app).post('/api/users/forgot-password').send({ email: 'nobody@example.com' });

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
    expect(known.body.message).toMatch(/If an account exists/);
  });

  it('never stores the reset code in readable form', async () => {
    const org = await createOrg();
    const { user } = await createOwner(org, { email: 'reset@example.com' });

    await request(app).post('/api/users/forgot-password').send({ email: 'reset@example.com' });

    const stored = await User.findById(user._id).lean();
    expect(stored.otpHash).toMatch(/^\$2[aby]\$/);   // a bcrypt hash, not six digits
    expect(stored.otp).toBeUndefined();
    expect(stored.otpExpiry.getTime()).toBeGreaterThan(Date.now());
  });

  it('accepts the emailed code once and then invalidates it', async () => {
    const org = await createOrg();
    const { user } = await createOwner(org, { email: 'once@example.com' });

    // Stand in for the email the user would receive.
    const code = '123456';
    await User.findByIdAndUpdate(user._id, {
      otpHash: await bcrypt.hash(code, 4),
      otpExpiry: new Date(Date.now() + 10 * 60 * 1000),
      otpAttempts: 0,
    });

    const first = await request(app).post('/api/users/reset-password')
      .send({ email: 'once@example.com', token: code, newPassword: 'BrandNewP@ss1' });
    expect(first.status).toBe(200);

    const second = await request(app).post('/api/users/reset-password')
      .send({ email: 'once@example.com', token: code, newPassword: 'AnotherP@ss12' });
    expect(second.status).toBe(400);

    const login = await request(app).post('/api/users/login')
      .send({ email: 'once@example.com', password: 'BrandNewP@ss1' });
    expect(login.status).toBe(200);
  });

  it('rejects an expired code', async () => {
    const org = await createOrg();
    const { user } = await createOwner(org, { email: 'expired@example.com' });
    await User.findByIdAndUpdate(user._id, {
      otpHash: await bcrypt.hash('123456', 4),
      otpExpiry: new Date(Date.now() - 1000),
    });

    const res = await request(app).post('/api/users/reset-password')
      .send({ email: 'expired@example.com', token: '123456', newPassword: 'BrandNewP@ss1' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/expired/i);
  });

  it('gives up after five wrong guesses at one code', async () => {
    const org = await createOrg();
    const { user } = await createOwner(org, { email: 'guess@example.com' });
    await User.findByIdAndUpdate(user._id, {
      otpHash: await bcrypt.hash('123456', 4),
      otpExpiry: new Date(Date.now() + 10 * 60 * 1000),
    });

    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/users/reset-password')
        .send({ email: 'guess@example.com', token: '000000', newPassword: 'BrandNewP@ss1' });
    }

    // Even the correct code is refused now; the user must request a fresh one.
    const res = await request(app).post('/api/users/reset-password')
      .send({ email: 'guess@example.com', token: '123456', newPassword: 'BrandNewP@ss1' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Too many incorrect attempts/);
  });
});

describe('token revocation (ENH-012)', () => {
  it('invalidates outstanding tokens on logout', async () => {
    const { owner, site } = await createWorld();

    const before = await request(app).get(`/api/inventory/${site.name}`).set(bearer(owner.token));
    expect(before.status).toBe(200);

    await request(app).post('/api/users/logout').set(bearer(owner.token)).send({});

    const after = await request(app).get(`/api/inventory/${site.name}`).set(bearer(owner.token));
    expect(after.status).toBe(401);
    expect(after.body.message).toMatch(/Session expired/);
  });

  it('invalidates tokens when a password is changed', async () => {
    const { owner, site } = await createWorld();

    const res = await request(app).post('/api/users/change-password').set(bearer(owner.token))
      .send({ currentPassword: PASSWORD, newPassword: 'A_Different1Pass' });
    expect(res.status).toBe(200);

    // The old token is dead; the caller is handed a fresh one so the device they
    // changed it on is not logged out.
    expect((await request(app).get(`/api/inventory/${site.name}`).set(bearer(owner.token))).status).toBe(401);
    expect((await request(app).get(`/api/inventory/${site.name}`).set(bearer(res.body.token))).status).toBe(200);
  });

  it('rejects a token for a deleted account (ENH-013)', async () => {
    const { org, site } = await createWorld();
    const second = await createOwner(org, { name: 'Second Owner' });

    await request(app).delete('/api/users/me').set(bearer(second.token));

    const res = await request(app).get(`/api/inventory/${site.name}`).set(bearer(second.token));
    expect(res.status).toBe(401);
  });
});

describe('account deletion (ENH-013)', () => {
  it('refuses to strand an organisation with no owner', async () => {
    const { owner } = await createWorld();
    const res = await request(app).delete('/api/users/me').set(bearer(owner.token));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('last_owner');
  });

  it('scrubs credentials and blocks login, keeping a retention window', async () => {
    const { org } = await createWorld();
    const second = await createOwner(org, { name: 'Second Owner', email: 'leaving@example.com' });

    const res = await request(app).delete('/api/users/me').set(bearer(second.token));
    expect(res.status).toBe(200);
    expect(new Date(res.body.purge_after).getTime()).toBeGreaterThan(Date.now());

    const stored = await User.findById(second.user._id).lean();
    expect(stored.password).toBe('');
    expect(stored.deletedAt).not.toBeNull();

    const login = await request(app).post('/api/users/login')
      .send({ email: 'leaving@example.com', password: PASSWORD });
    expect(login.status).toBe(401);
  });
});

describe('multi-device push tokens (ENH-014)', () => {
  it('keeps a token per device instead of the last one winning', async () => {
    const { owner } = await createWorld();

    await request(app).put('/api/users/fcm-token').set(bearer(owner.token)).send({ token: 'phone-token' });
    await request(app).put('/api/users/fcm-token').set(bearer(owner.token)).send({ token: 'tablet-token' });

    const stored = await User.findById(owner.user._id).lean();
    expect(stored.fcmTokens.map((t) => t.token).sort()).toEqual(['phone-token', 'tablet-token']);
  });

  it('refreshes rather than duplicates a token it already knows', async () => {
    const { owner } = await createWorld();
    await request(app).put('/api/users/fcm-token').set(bearer(owner.token)).send({ token: 'same-token' });
    await request(app).put('/api/users/fcm-token').set(bearer(owner.token)).send({ token: 'same-token' });

    const stored = await User.findById(owner.user._id).lean();
    expect(stored.fcmTokens).toHaveLength(1);
  });

  it('drops the device token on logout', async () => {
    const { owner } = await createWorld();
    await request(app).put('/api/users/fcm-token').set(bearer(owner.token)).send({ token: 'phone-token' });
    await request(app).post('/api/users/logout').set(bearer(owner.token)).send({ fcmToken: 'phone-token' });

    const stored = await User.findById(owner.user._id).lean();
    expect(stored.fcmTokens).toHaveLength(0);
  });
});

describe('auth basics', () => {
  it('refuses a request with no token', async () => {
    const res = await request(app).get('/api/sites');
    expect(res.status).toBe(401);
  });

  it('refuses a forged token', async () => {
    const res = await request(app).get('/api/sites').set(bearer('not.a.real.token'));
    expect(res.status).toBe(401);
  });

  it('refuses a manager on an owner-only route', async () => {
    const { manager } = await createWorld();
    const res = await request(app).get('/api/sites').set(bearer(manager.token));
    expect(res.status).toBe(403);
  });

  it('refuses a user with no organisation', async () => {
    const orphan = await User.create({ name: 'Orphan', role: 'owner', status: 'approved', orgId: null });
    const res = await request(app).get('/api/sites').set(bearer(makeToken(orphan)));
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/not associated with any company/);
  });
});
