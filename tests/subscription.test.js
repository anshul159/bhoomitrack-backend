const request = require('supertest');
const app = require('../server');
const Organization = require('../models/Organization');
const { createWorld, bearer } = require('./helpers/factories');

// ENH-003. An organisation used to be created by self-registration and then exist
// forever — no plan, no expiry, no way to stop serving a customer who stops
// paying. The payment provider itself is still outstanding; this is the lifecycle
// the API enforces around it.
describe('subscription gate', () => {
  const lapse = (org, patch) => Organization.findByIdAndUpdate(org._id, patch);

  it('serves an organisation on an active subscription', async () => {
    const { owner, site } = await createWorld();
    expect((await request(app).get(`/api/inventory/${site.name}`).set(bearer(owner.token))).status).toBe(200);
  });

  it('serves an organisation inside its trial', async () => {
    const { org, owner, site } = await createWorld();
    await lapse(org, { status: 'trialing', trialEndsAt: new Date(Date.now() + 86400000) });
    expect((await request(app).get(`/api/inventory/${site.name}`).set(bearer(owner.token))).status).toBe(200);
  });

  it('answers 402 once a trial has lapsed', async () => {
    const { org, owner, site } = await createWorld();
    await lapse(org, { status: 'trialing', trialEndsAt: new Date(Date.now() - 1000) });

    const res = await request(app).get(`/api/inventory/${site.name}`).set(bearer(owner.token));
    // 402 rather than 403 so the app can show a billing screen instead of
    // "access denied", which would read as a bug.
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('subscription_inactive');
    expect(res.body.message).toMatch(/free trial has ended/);
  });

  it('answers 402 for a suspended organisation, with the stated reason', async () => {
    const { org, owner, site } = await createWorld();
    await lapse(org, { status: 'suspended', suspensionReason: 'Payment failed twice' });

    const res = await request(app).get(`/api/inventory/${site.name}`).set(bearer(owner.token));
    expect(res.status).toBe(402);
    expect(res.body.message).toBe('Payment failed twice');
  });

  it('blocks writes as well as reads', async () => {
    const { org, manager, site, item } = await createWorld();
    await lapse(org, { status: 'cancelled' });

    const res = await request(app).post('/api/slips/generate').set(bearer(manager.token))
      .send({ site_name: site.name, items: [{ inventory_id: item._id, quantity_taken: 1 }] });
    expect(res.status).toBe(402);
  });

  it('still lets a lapsed customer see what they owe', async () => {
    const { org, owner } = await createWorld();
    await lapse(org, { status: 'past_due' });

    const res = await request(app).get('/api/org/subscription').set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(false);
    expect(res.body.data.status).toBe('past_due');
  });

  it('still lets a lapsed customer export their data', async () => {
    // Locking export behind payment turns a billing problem into a hostage
    // situation, so both routes sit outside the gate deliberately.
    const { org, owner } = await createWorld();
    await lapse(org, { status: 'suspended' });

    const res = await request(app).get('/api/org/export').set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.counts.sites).toBe(1);
  });

  it('reports days remaining on a trial', async () => {
    const { org, owner } = await createWorld();
    await lapse(org, { status: 'trialing', trialEndsAt: new Date(Date.now() + 10 * 86400000) });

    const res = await request(app).get('/api/org/subscription').set(bearer(owner.token));
    expect(res.body.data.days_remaining).toBe(10);
    expect(res.body.data.billing_portal_url).toBeNull(); // no provider integrated yet
  });
});

describe('data export (ENH-013)', () => {
  it('includes every collection and excludes credentials', async () => {
    const { owner } = await createWorld();
    const res = await request(app).get('/api/org/export').set(bearer(owner.token));

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=/);
    expect(res.body.organization.name).toBe('Test Construction Co');
    expect(res.body.sites).toHaveLength(1);
    expect(res.body.inventory).toHaveLength(1);

    for (const user of res.body.users) {
      expect(user.password).toBeUndefined();
      expect(user.otpHash).toBeUndefined();
      expect(user.fcmTokens).toBeUndefined();
    }
  });

  it('is refused to a manager', async () => {
    const { manager } = await createWorld();
    expect((await request(app).get('/api/org/export').set(bearer(manager.token))).status).toBe(403);
  });
});
