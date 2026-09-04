const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');
const User = require('../models/User');
const { createWorld, createOwner, PASSWORD, bearer } = require('./helpers/factories');

// The web console's entitlement (WEB-APP-PLAN §4).
//
// Two facts are kept deliberately apart and both are tested here:
//   webAppAccess          — may this PERSON use the console
//   Organization.status   — has this COMPANY paid (see subscription.test.js)
// The second is never copied onto a user row: managers would need a copy too, and
// one subscription would become N that drift.
describe('web console login', () => {
  const webLogin = (email) => request(app).post('/api/users/web-login').send({ email, password: PASSWORD });

  it('lets the super admin in without the flag ever being set', async () => {
    const { org } = await createWorld();
    const { user } = await createOwner(org, { role: 'super_admin' });
    expect(user.webAppAccess).toBe(false); // implicit, not stored

    const res = await webLogin(user.email);
    expect(res.status).toBe(200);
    expect(res.body.user.is_super_admin).toBe(true);
    expect(res.body.user.web_app_access).toBe(true);
  });

  it('refuses an owner who has not been granted access', async () => {
    const { owner } = await createWorld();
    const res = await webLogin(owner.user.email);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('web_access_not_granted');
    expect(res.body.message).toMatch(/Ask your Super Admin/);
  });

  it('lets that same owner in once granted', async () => {
    const { owner } = await createWorld();
    await User.findByIdAndUpdate(owner.user._id, { webAppAccess: true });
    const res = await webLogin(owner.user.email);
    expect(res.status).toBe(200);
    expect(res.body.user.web_app_access).toBe(true);
  });

  it('gives a web session a shorter life than an app session', async () => {
    // 30 days in a browser on a laptop that may not be theirs alone is too long.
    const { owner } = await createWorld();
    await User.findByIdAndUpdate(owner.user._id, { webAppAccess: true });

    const web = jwt.decode((await webLogin(owner.user.email)).body.token);
    const appToken = jwt.decode((await request(app).post('/api/users/login')
      .send({ email: owner.user.email, password: PASSWORD })).body.token);

    expect(web.exp - web.iat).toBeLessThan(appToken.exp - appToken.iat);
    expect(web.exp - web.iat).toBe(12 * 60 * 60);
  });

  it('answers a wrong password exactly as /login does, granted or not', async () => {
    // The entitlement refusal is only reachable after the password is proved, so
    // it cannot be used to find out who has an account.
    const { owner } = await createWorld();
    await User.findByIdAndUpdate(owner.user._id, { webAppAccess: true });

    const wrong = await request(app).post('/api/users/web-login')
      .send({ email: owner.user.email, password: 'not-the-password' });
    const missing = await request(app).post('/api/users/web-login')
      .send({ email: 'nobody@example.com', password: 'not-the-password' });

    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.body.message).toBe(missing.body.message);
  });

  it('never lets a manager reach the console', async () => {
    const { manager } = await createWorld();
    await User.findByIdAndUpdate(manager.user._id, { webAppAccess: true }); // even so
    const res = await request(app).post('/api/users/web-login')
      .send({ email: manager.user.email || 'x@y.com', password: PASSWORD });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/users/owners', () => {
  it('lists every owner with their entitlement', async () => {
    const { org, owner } = await createWorld();
    const { user: sa } = await createOwner(org, { role: 'super_admin' });
    await User.findByIdAndUpdate(owner.user._id, { webAppAccess: true });

    const res = await request(app).get('/api/users/owners').set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);

    const superAdmin = res.body.data.find((u) => String(u.id) === String(sa._id));
    expect(superAdmin.is_super_admin).toBe(true);
    expect(superAdmin.web_app_access).toBe(true); // implicit
    expect(res.body.data.find((u) => String(u.id) === String(owner.user._id)).web_app_access).toBe(true);
  });

  it('does not leak owners from another organisation', async () => {
    const a = await createWorld();
    await createWorld();
    const res = await request(app).get('/api/users/owners').set(bearer(a.owner.token));
    expect(res.body.data.every((u) => String(u.id) === String(a.owner.user._id))).toBe(true);
  });

  it('is refused to a manager', async () => {
    const { manager } = await createWorld();
    expect((await request(app).get('/api/users/owners').set(bearer(manager.token))).status).toBe(403);
  });
});

describe('PUT /api/users/:userId/web-access', () => {
  const grant = (token, id, enabled) =>
    request(app).put(`/api/users/${id}/web-access`).set(bearer(token)).send({ enabled });

  it('lets the super admin grant an owner access', async () => {
    const { org, owner } = await createWorld();
    const sa = await createOwner(org, { role: 'super_admin' });

    const res = await grant(sa.token, owner.user._id, true);
    expect(res.status).toBe(200);
    expect(res.body.data.web_app_access).toBe(true);
    expect((await User.findById(owner.user._id)).webAppAccess).toBe(true);
  });

  it('refuses an owner who merely holds the entitlement themselves', async () => {
    // An owner given web access cannot pass it on.
    const { org, owner } = await createWorld();
    await User.findByIdAndUpdate(owner.user._id, { webAppAccess: true });
    const other = await createOwner(org);

    expect((await grant(owner.token, other.user._id, true)).status).toBe(403);
  });

  it('refuses to toggle the super admin, who holds it implicitly', async () => {
    const { org } = await createWorld();
    const sa = await createOwner(org, { role: 'super_admin' });
    const res = await grant(sa.token, sa.user._id, false);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/always has web access/);
  });

  it('refuses to give a manager web access', async () => {
    const { org, manager } = await createWorld();
    const sa = await createOwner(org, { role: 'super_admin' });
    expect((await grant(sa.token, manager.user._id, true)).status).toBe(400);
  });

  it('cannot reach an owner in another organisation', async () => {
    const { org } = await createWorld();
    const sa = await createOwner(org, { role: 'super_admin' });
    const stranger = await createWorld();
    expect((await grant(sa.token, stranger.owner.user._id, true)).status).toBe(404);
  });

  it('revokes on the next request, without ending the Android session', async () => {
    // auth.js reads webAppAccess live, so no tokenVersion bump is needed — and a
    // bump would have signed the owner out of their phone for a web-only change.
    const { org, owner } = await createWorld();
    const sa = await createOwner(org, { role: 'super_admin' });
    await grant(sa.token, owner.user._id, true);

    const web = await request(app).post('/api/users/web-login')
      .send({ email: owner.user.email, password: PASSWORD });
    expect(web.status).toBe(200);

    await grant(sa.token, owner.user._id, false);

    // The console door is shut...
    expect((await request(app).post('/api/users/web-login')
      .send({ email: owner.user.email, password: PASSWORD })).status).toBe(403);
    // ...and the token they already held on their phone still works.
    expect((await request(app).get('/api/users/me').set(bearer(owner.token))).status).toBe(200);
  });

  it('rejects a missing or non-boolean `enabled`', async () => {
    const { org, owner } = await createWorld();
    const sa = await createOwner(org, { role: 'super_admin' });
    expect((await request(app).put(`/api/users/${owner.user._id}/web-access`)
      .set(bearer(sa.token)).send({})).status).toBe(400);
  });
});
