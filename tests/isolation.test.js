const request = require('supertest');
const app = require('../server');
const { createWorld, createSite, createInventory, createManager, bearer } = require('./helpers/factories');

// Tenant isolation is the promise the product cannot break: two customers share
// one database, and nothing may cross between them.
describe('organisation isolation', () => {
  let a, b;

  beforeEach(async () => {
    a = await createWorld();
    b = await createWorld();
  });

  it("does not list another organisation's sites", async () => {
    const res = await request(app).get('/api/sites').set(bearer(a.owner.token));
    expect(res.status).toBe(200);
    const names = res.body.data.map((s) => String(s.id));
    expect(names).toContain(String(a.site._id));
    expect(names).not.toContain(String(b.site._id));
  });

  it("cannot read another organisation's inventory even by exact site name", async () => {
    // Both worlds use the name "Site A", so this resolves within the caller's
    // own org or not at all.
    const res = await request(app).get(`/api/inventory/${b.site.name}`).set(bearer(a.owner.token));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((i) => String(i.id));
    expect(ids).toContain(String(a.item._id));
    expect(ids).not.toContain(String(b.item._id));
  });

  it("cannot approve another organisation's slip", async () => {
    const gen = await request(app).post('/api/slips/generate').set(bearer(b.manager.token))
      .send({ site_name: b.site.name, items: [{ inventory_id: b.item._id, quantity_taken: 5 }] });

    const res = await request(app).put(`/api/slips/approve/${gen.body.data.id}`).set(bearer(a.owner.token));
    expect(res.status).toBe(404);
  });

  it("cannot update another organisation's inventory item", async () => {
    const res = await request(app)
      .put(`/api/inventory/update/${b.item._id}`)
      .set(bearer(a.owner.token))
      .send({ quantity: 5 });
    expect(res.status).toBe(404);
  });

  it("cannot delete another organisation's inventory item", async () => {
    const res = await request(app)
      .delete(`/api/inventory/delete/${b.item._id}`)
      .set(bearer(a.owner.token));
    expect(res.status).toBe(404);
  });

  it("cannot read another organisation's audit trail", async () => {
    await request(app).put(`/api/inventory/update/${b.item._id}`).set(bearer(b.owner.token)).send({ quantity: 7 });
    const res = await request(app).get('/api/audit').set(bearer(a.owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it("cannot message a user in another organisation", async () => {
    const res = await request(app).post('/api/chat/send').set(bearer(a.owner.token))
      .send({ receiver_id: b.manager.user._id, message: 'hello' });
    expect(res.status).toBe(404);
  });

  it("cannot read a chat thread with a user in another organisation (ENH-020)", async () => {
    // The query could never have returned another org's messages, but it used to
    // distinguish "no conversation" from "not your org" — an existence oracle.
    const res = await request(app).get(`/api/chat/${b.manager.user._id}`).set(bearer(a.owner.token));
    expect(res.status).toBe(404);
  });
});

// ENH-024 — the API used to trust the app to send the right site.
describe('site scope for managers', () => {
  it('lets a manager read their own site', async () => {
    const { site, manager } = await createWorld();
    const res = await request(app).get(`/api/inventory/${site.name}`).set(bearer(manager.token));
    expect(res.status).toBe(200);
  });

  it('refuses a manager reading another site in the same organisation', async () => {
    const { org, manager } = await createWorld();
    const otherSite = await createSite(org, 'Site B');
    await createInventory(org, otherSite);

    for (const path of [
      `/api/inventory/${otherSite.name}`,
      `/api/slips/${otherSite.name}`,
      `/api/slips/last/${otherSite.name}`,
      `/api/orders/${otherSite.name}`,
    ]) {
      const res = await request(app).get(path).set(bearer(manager.token));
      expect([path, res.status]).toEqual([path, 403]);
    }
  });

  it('lets an owner read every site in their organisation', async () => {
    const { org, owner } = await createWorld();
    const otherSite = await createSite(org, 'Site B');
    await createInventory(org, otherSite);

    const res = await request(app).get(`/api/inventory/${otherSite.name}`).set(bearer(owner.token));
    expect(res.status).toBe(200);
  });

  it('lets a manager holding two sites read both (ENH-016)', async () => {
    const { org, site } = await createWorld();
    const second = await createSite(org, 'Site B');
    await createInventory(org, second);
    const manager = await createManager(org, site);

    await request(app)
      .put(`/api/users/assign-site/${manager.user._id}`)
      .set(bearer((await createWorldOwner(org)).token))
      .send({ siteNames: [site.name, second.name] });

    // The assignment bumped tokenVersion, so a fresh token is required — which is
    // itself the ENH-012 behaviour.
    const { makeToken } = require('../utils/token');
    const User = require('../models/User');
    const refreshed = await User.findById(manager.user._id);
    const token = makeToken(refreshed);

    for (const s of [site, second]) {
      const res = await request(app).get(`/api/inventory/${s.name}`).set(bearer(token));
      expect([s.name, res.status]).toEqual([s.name, 200]);
    }
  });
});

// Small helper: an extra owner for an existing org.
async function createWorldOwner(org) {
  const { createOwner } = require('./helpers/factories');
  return createOwner(org, { name: 'Second Owner' });
}
