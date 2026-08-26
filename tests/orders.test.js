const request = require('supertest');
const app = require('../server');
const Order = require('../models/Order');
const { createWorld, createSite, createInventory, bearer } = require('./helpers/factories');

// CR-003. The request half of this feature was deleted as dead code, leaving the
// Orders screen and the whole Procurement report running on data nothing could
// add to. These tests cover the rebuilt half.
describe('material requests (CR-003)', () => {
  it('lets a manager raise a request against their own site', async () => {
    const { site, manager } = await createWorld();

    const res = await request(app).post('/api/orders/request').set(bearer(manager.token))
      .send({ material_name: 'Cement', quantity: 50, reason: 'Slab pour on Friday' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.site_name).toBe(site.name);
    expect(res.body.data.requested_by).toBe('Test Manager');
    expect(res.body.data.reason).toBe('Slab pour on Friday');
  });

  it('prices the request from the site stock record when the material is known', async () => {
    const { org, site, manager } = await createWorld();
    await createInventory(org, site, { name: 'Steel', unit: 'tonnes', unit_cost: 5000 });

    const res = await request(app).post('/api/orders/request').set(bearer(manager.token))
      .send({ material_name: 'steel', quantity: 3 });   // case-insensitive match

    expect(res.body.data.unit_cost).toBe(5000);
    expect(res.body.data.estimated_total).toBe(15000);
    expect(res.body.data.unit).toBe('tonnes');
  });

  it('leaves the price unknown for a material the site does not stock', async () => {
    const { manager } = await createWorld();
    const res = await request(app).post('/api/orders/request').set(bearer(manager.token))
      .send({ material_name: 'Scaffolding', quantity: 20 });
    expect(res.body.data.unit_cost).toBeNull();
    expect(res.body.data.estimated_total).toBeNull();
  });

  it('ignores a site in the body and uses the manager\'s own assignment', async () => {
    const { org, site, manager } = await createWorld();
    const other = await createSite(org, 'Site B');

    const res = await request(app).post('/api/orders/request').set(bearer(manager.token))
      .send({ material_name: 'Cement', quantity: 10, site_name: other.name });

    expect(res.status).toBe(200);
    expect(res.body.data.site_name).toBe(site.name);
  });

  it('rejects a non-positive quantity', async () => {
    const { manager } = await createWorld();
    const res = await request(app).post('/api/orders/request').set(bearer(manager.token))
      .send({ material_name: 'Cement', quantity: 0 });
    expect(res.status).toBe(400);
  });

  it('refuses a manager with no site assigned', async () => {
    const { org } = await createWorld();
    const { createManager } = require('./helpers/factories');
    const unassigned = await createManager(org, null, { name: 'Unassigned' });

    const res = await request(app).post('/api/orders/request').set(bearer(unassigned.token))
      .send({ material_name: 'Cement', quantity: 10 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not assigned to a site/);
  });

  it('shows the request to the owner and lets them accept it', async () => {
    const { owner, manager } = await createWorld();
    const created = await request(app).post('/api/orders/request').set(bearer(manager.token))
      .send({ material_name: 'Cement', quantity: 50 });

    const list = await request(app).get('/api/orders').set(bearer(owner.token));
    expect(list.body.data).toHaveLength(1);

    const accepted = await request(app).put(`/api/orders/accept/${created.body.data.id}`)
      .set(bearer(owner.token)).send({ note: 'Ordered from supplier' });

    expect(accepted.status).toBe(200);
    const stored = await Order.findById(created.body.data.id);
    expect(stored.status).toBe('accepted');
    expect(stored.decision_note).toBe('Ordered from supplier');
    expect(stored.decided_at).not.toBeNull();
  });

  it('cannot be decided twice', async () => {
    const { owner, manager } = await createWorld();
    const created = await request(app).post('/api/orders/request').set(bearer(manager.token))
      .send({ material_name: 'Cement', quantity: 50 });

    await request(app).put(`/api/orders/accept/${created.body.data.id}`).set(bearer(owner.token));
    const again = await request(app).put(`/api/orders/reject/${created.body.data.id}`).set(bearer(owner.token));

    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/already accepted/);
  });

  it('refuses a manager deciding on a request', async () => {
    const { manager } = await createWorld();
    const created = await request(app).post('/api/orders/request').set(bearer(manager.token))
      .send({ material_name: 'Cement', quantity: 50 });

    const res = await request(app).put(`/api/orders/accept/${created.body.data.id}`).set(bearer(manager.token));
    expect(res.status).toBe(403);
  });
});
