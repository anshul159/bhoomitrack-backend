const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { createWorld, createOwner, createManager, createSite, PASSWORD, bearer } = require('./helpers/factories');

// Admin-initiated password reset for managers.
//
// A manager has no self-service route back in: `forgot-password` matches only
// owners and super admins, and a manager signs in by PHONE, so an emailed code
// could not reach them even if the lookup allowed it. Before this endpoint a
// manager who forgot their password was locked out permanently and nobody —
// not even their own Super Admin — could help.
describe('manager password reset by an admin', () => {
  const reset = (token, id) =>
    request(app).post(`/api/users/managers/${id}/reset-password`).set(bearer(token));

  const managerLogin = (phone, password) =>
    request(app).post('/api/users/manager-login').send({ phone, password });

  it('issues a working temporary password and returns it exactly once', async () => {
    const { owner, manager } = await createWorld();

    const res = await reset(owner.token, manager.user._id);
    expect(res.status).toBe(200);

    const temp = res.body.data.tempPassword;
    expect(typeof temp).toBe('string');
    expect(temp).toHaveLength(12);

    // The point of the whole endpoint: the manager can actually get back in.
    const login = await managerLogin(manager.user.phone, temp);
    expect(login.status).toBe(200);
  });

  it('makes the old password stop working', async () => {
    const { owner, manager } = await createWorld();
    expect((await managerLogin(manager.user.phone, PASSWORD)).status).toBe(200);

    await reset(owner.token, manager.user._id);

    const after = await managerLogin(manager.user.phone, PASSWORD);
    expect(after.status).toBe(401);
  });

  it('ends every existing session, because a reset is what you do when a phone is lost', async () => {
    const { org, owner, site } = await createWorld();
    const manager = await createManager(org, site);

    // /api/users/me is guarded by `auth` alone, so it tests the token itself
    // rather than what a manager is authorised to see.
    const before = await request(app).get('/api/users/me').set(bearer(manager.token));
    expect(before.status).toBe(200);

    await reset(owner.token, manager.user._id);

    // tokenVersion was bumped, so the token issued earlier is now refused.
    const after = await request(app).get('/api/users/me').set(bearer(manager.token));
    expect(after.status).toBe(401);
  });

  it('never generates a password that its own policy would reject', async () => {
    const { org, owner, site } = await createWorld();
    // Run it enough times to catch an alphabet that can produce all-digits or a
    // single repeated character, both of which validatePassword refuses.
    for (let i = 0; i < 25; i += 1) {
      const manager = await createManager(org, site);
      const res = await reset(owner.token, manager.user._id);
      expect(res.status).toBe(200);

      const temp = res.body.data.tempPassword;
      const change = await request(app)
        .post('/api/users/change-password')
        .set(bearer((await managerLogin(manager.user.phone, temp)).body.token))
        .send({ currentPassword: temp, newPassword: 'An0therStr0ngOne!' });
      expect(change.status).toBe(200);
    }
  });

  it('clears any half-finished reset code', async () => {
    const { owner, manager } = await createWorld();
    await User.findByIdAndUpdate(manager.user._id, {
      otpHash: await bcrypt.hash('123456', 4),
      otpExpiry: new Date(Date.now() + 600000),
      otpAttempts: 3,
    });

    await reset(owner.token, manager.user._id);

    const fresh = await User.findById(manager.user._id).lean();
    expect(fresh.otpHash).toBeNull();
    expect(fresh.otpExpiry).toBeNull();
    expect(fresh.otpAttempts).toBe(0);
  });

  it('records who did it', async () => {
    const { owner, manager } = await createWorld();
    await reset(owner.token, manager.user._id);

    const row = await AuditLog.findOne({ action: 'user.password_reset_by_admin' }).lean();
    expect(row).toBeTruthy();
    expect(String(row.entity_id)).toBe(String(manager.user._id));
    expect(String(row.actor_id)).toBe(String(owner.user._id));
  });

  // ─── Who may not use it ────────────────────────────────────────────────────

  it('refuses a manager trying to reset anybody, including themselves', async () => {
    const { manager } = await createWorld();
    const res = await reset(manager.token, manager.user._id);
    expect(res.status).toBe(403);
  });

  it('refuses an owner from another organisation', async () => {
    const { manager } = await createWorld();
    const otherWorld = await createWorld();

    const res = await reset(otherWorld.owner.token, manager.user._id);
    expect(res.status).toBe(404);

    // And the manager's original password still works — nothing was changed.
    expect((await managerLogin(manager.user.phone, PASSWORD)).status).toBe(200);
  });

  it('refuses to reset an owner or super admin through the manager route', async () => {
    const { org, owner } = await createWorld();
    const target = await createOwner(org, { role: 'owner' });

    const res = await reset(owner.token, target.user._id);
    expect(res.status).toBe(404);
  });

  it('refuses a deleted manager', async () => {
    const { owner, manager } = await createWorld();
    await User.findByIdAndUpdate(manager.user._id, { deletedAt: new Date() });

    const res = await reset(owner.token, manager.user._id);
    expect(res.status).toBe(404);
  });

  it('rejects an id that is not an object id', async () => {
    const { owner } = await createWorld();
    const res = await reset(owner.token, 'not-an-id');
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    const { manager } = await createWorld();
    const res = await request(app).post(`/api/users/managers/${manager.user._id}/reset-password`);
    expect(res.status).toBe(401);
  });

  it('gives two managers different passwords', async () => {
    const { org, owner, site } = await createWorld();
    const a = await createManager(org, site);
    const b = await createManager(org, site);

    const ra = await reset(owner.token, a.user._id);
    const rb = await reset(owner.token, b.user._id);
    expect(ra.body.data.tempPassword).not.toBe(rb.body.data.tempPassword);
  });
});
