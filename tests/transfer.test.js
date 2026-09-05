const request = require('supertest');
const app = require('../server');
const Organization = require('../models/Organization');
const User = require('../models/User');
const mailer = require('../utils/mailer');
const { createWorld, createOwner, bearer } = require('./helpers/factories');

// Super Admin transfer (WEB-APP-PLAN §7.4). The most consequential action in the
// product: it moves who may grant web access and who may transfer the role again.

describe('super admin transfer', () => {
  let sent;
  beforeEach(() => {
    sent = [];
    // SMTP is deliberately unconfigured in tests (helpers/env.js), where the real
    // mailer WARNS AND RETURNS FALSE. Standing in for it here lets us assert both
    // the happy path and — in its own test — that a false return is treated as a
    // failure rather than a success.
    jest.spyOn(mailer, 'sendSuperAdminTransferEmail').mockImplementation(async (to, name, targetName, code) => {
      sent.push({ to, name, targetName, code });
      return true;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  async function world() {
    const { org, owner } = await createWorld();
    const sa = await createOwner(org, { role: 'super_admin', name: 'Sita Sharma' });
    await Organization.findByIdAndUpdate(org._id, { superAdminId: sa.user._id });
    return { org, owner, sa };
  }

  const req = (token, body) => request(app).post('/api/org/super-admin/transfer/request').set(bearer(token)).send(body);
  const confirm = (token, code) => request(app).post('/api/org/super-admin/transfer/confirm').set(bearer(token)).send({ code });

  it('emails the code to the OUTGOING holder, never to the person being promoted', async () => {
    const { owner, sa } = await world();
    const res = await req(sa.token, { toUserId: owner.user._id });

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    // The code is what proves the outgoing holder agreed.
    expect(sent[0].to).toBe(sa.user.email);
    expect(sent[0].to).not.toBe(owner.user.email);
    expect(sent[0].targetName).toBe(owner.user.name);
    expect(sent[0].code).toMatch(/^\d{6}$/);
  });

  it('never stores the code in the clear', async () => {
    const { org, owner, sa } = await world();
    await req(sa.token, { toUserId: owner.user._id });

    const fresh = await Organization.findById(org._id);
    expect(fresh.pendingTransfer.otpHash).not.toBe(sent[0].code);
    expect(fresh.pendingTransfer.otpHash.startsWith('$2')).toBe(true);
  });

  it('does not touch User.otpHash, which password reset owns', async () => {
    // Sharing those fields would mean a password reset silently cancelling a
    // transfer, and both failures look identical: "the code didn't work."
    const { owner, sa } = await world();
    await req(sa.token, { toUserId: owner.user._id });

    expect((await User.findById(sa.user._id)).otpHash).toBeNull();
    expect((await User.findById(owner.user._id)).otpHash).toBeNull();
  });

  it('performs the swap, and hands the outgoing holder web access', async () => {
    const { org, owner, sa } = await world();
    await req(sa.token, { toUserId: owner.user._id });

    const res = await confirm(sa.token, sent[0].code);
    expect(res.status).toBe(200);

    const promoted = await User.findById(owner.user._id);
    const demoted = await User.findById(sa.user._id);
    expect(promoted.role).toBe('super_admin');
    expect(demoted.role).toBe('owner');
    // Without this the outgoing holder instantly loses the console they just
    // handed over, and only the person they promoted could give it back.
    expect(demoted.webAppAccess).toBe(true);
    expect(String((await Organization.findById(org._id)).superAdminId)).toBe(String(owner.user._id));
  });

  it('signs both of them out, which is what makes it immediate', async () => {
    const { owner, sa } = await world();
    const before = {
      sa: (await User.findById(sa.user._id)).tokenVersion || 0,
      owner: (await User.findById(owner.user._id)).tokenVersion || 0,
    };
    await req(sa.token, { toUserId: owner.user._id });
    await confirm(sa.token, sent[0].code);

    expect((await User.findById(sa.user._id)).tokenVersion).toBe(before.sa + 1);
    expect((await User.findById(owner.user._id)).tokenVersion).toBe(before.owner + 1);
    // And the old tokens really are dead.
    expect((await request(app).get('/api/users/me').set(bearer(sa.token))).status).toBe(401);
  });

  it('clears the pending transfer once used, so a code cannot be replayed', async () => {
    const { org, owner, sa } = await world();
    await req(sa.token, { toUserId: owner.user._id });
    await confirm(sa.token, sent[0].code);

    expect((await Organization.findById(org._id)).pendingTransfer).toBeNull();
  });

  it('refuses a code that was never sent', async () => {
    // utils/mailer.js warns and returns FALSE in development. A confirm step that
    // accepted a code which was never delivered would be a hole.
    mailer.sendSuperAdminTransferEmail.mockResolvedValueOnce(false);
    const { org, owner, sa } = await world();

    const res = await req(sa.token, { toUserId: owner.user._id });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('mail_not_configured');
    // Nothing was stored, so nothing can be confirmed.
    expect((await Organization.findById(org._id)).pendingTransfer).toBeNull();
  });

  it('counts wrong codes and gives up after five', async () => {
    const { org, owner, sa } = await world();
    await req(sa.token, { toUserId: owner.user._id });

    for (let i = 1; i <= 5; i++) {
      const res = await confirm(sa.token, '000000');
      expect(res.status).toBe(400);
      expect(res.body.data.attempts_left).toBe(5 - i);
    }
    expect((await confirm(sa.token, sent[0].code)).status).toBe(429);
    expect((await Organization.findById(org._id)).pendingTransfer).toBeNull();
  });

  it('refuses an expired code', async () => {
    const { org, owner, sa } = await world();
    await req(sa.token, { toUserId: owner.user._id });
    await Organization.findByIdAndUpdate(org._id, { 'pendingTransfer.expiresAt': new Date(Date.now() - 1000) });

    expect((await confirm(sa.token, sent[0].code)).status).toBe(400);
  });

  it('refuses an owner who is not the super admin', async () => {
    const { owner, sa } = await world();
    expect((await req(owner.token, { toUserId: sa.user._id })).status).toBe(403);
    expect((await confirm(owner.token, '123456')).status).toBe(403);
  });

  it('refuses a manager as the target — only an owner can hold the role', async () => {
    const { org, sa } = await world();
    const { manager } = await createWorld();
    const own = await User.findOne({ orgId: org._id, role: 'manager' });
    const targetId = own?._id || manager.user._id;
    expect((await req(sa.token, { toUserId: targetId })).status).toBe(400);
  });

  it('cannot reach an owner in another organisation', async () => {
    const { sa } = await world();
    const stranger = await createWorld();
    expect((await req(sa.token, { toUserId: stranger.owner.user._id })).status).toBe(404);
  });

  it('refuses to transfer to yourself', async () => {
    const { sa } = await world();
    const res = await req(sa.token, { toUserId: sa.user._id });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already the Super Admin/);
  });

  it('reports what is in flight, and cancels it', async () => {
    const { owner, sa } = await world();
    await req(sa.token, { toUserId: owner.user._id });

    const status = await request(app).get('/api/org/super-admin/transfer').set(bearer(sa.token));
    expect(status.body.data.to_name).toBe(owner.user.name);
    expect(status.body.data.attempts_left).toBe(5);

    expect((await request(app).post('/api/org/super-admin/transfer/cancel').set(bearer(sa.token))).status).toBe(200);
    expect((await request(app).get('/api/org/super-admin/transfer').set(bearer(sa.token))).body.data).toBeNull();
  });

  it('still answers when the subscription has lapsed', async () => {
    // The org routes sit outside requireActiveOrg on purpose. Locking an
    // organisation out of its own administration over a bill is a hostage
    // situation, not a dunning strategy.
    const { org, owner, sa } = await world();
    await Organization.findByIdAndUpdate(org._id, { status: 'past_due' });
    expect((await req(sa.token, { toUserId: owner.user._id })).status).toBe(200);
  });
});
