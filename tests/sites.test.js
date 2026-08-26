const request = require('supertest');
const app = require('../server');
const Inventory = require('../models/Inventory');
const Slip = require('../models/Slip');
const User = require('../models/User');
const { createWorld, bearer } = require('./helpers/factories');

// ENH-007. Data used to be keyed on the site *name*, so renaming a site would
// silently orphan every inventory item, slip and assignment attached to it.
// There was no rename endpoint, which was the only reason it had never caused
// damage. These tests are what make renaming safe to offer.
describe('site rename (ENH-007)', () => {
  async function worldWithSlip() {
    const world = await createWorld();
    const gen = await request(app).post('/api/slips/generate').set(bearer(world.manager.token))
      .send({ site_name: world.site.name, items: [{ inventory_id: world.item._id, quantity_taken: 5 }] });
    return { ...world, slipId: gen.body.data.id };
  }

  it('carries inventory, slips and assignments across the rename', async () => {
    const { owner, site, item, manager, slipId } = await worldWithSlip();

    const res = await request(app).put(`/api/sites/rename/${site._id}`)
      .set(bearer(owner.token)).send({ name: 'Riverside Phase 2' });

    expect(res.status).toBe(200);
    expect(res.body.data.updated.inventory).toBe(1);
    expect(res.body.data.updated.slips).toBe(1);

    // Nothing is orphaned: every record still points at the same site, and its
    // display name has moved with it.
    expect((await Inventory.findById(item._id)).site_name).toBe('Riverside Phase 2');
    expect(String((await Inventory.findById(item._id)).site_id)).toBe(String(site._id));
    expect((await Slip.findById(slipId)).site_name).toBe('Riverside Phase 2');
    expect((await User.findById(manager.user._id)).site_name).toBe('Riverside Phase 2');
  });

  it('keeps the data reachable under the new name', async () => {
    const { owner, site, item } = await worldWithSlip();
    await request(app).put(`/api/sites/rename/${site._id}`).set(bearer(owner.token)).send({ name: 'Renamed Site' });

    const res = await request(app).get('/api/inventory/Renamed Site').set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data.map((i) => i.id)).toContain(String(item._id));
  });

  it('refuses a name another site already uses', async () => {
    const { org, owner, site } = await createWorld();
    const { createSite } = require('./helpers/factories');
    await createSite(org, 'Site B');

    const res = await request(app).put(`/api/sites/rename/${site._id}`)
      .set(bearer(owner.token)).send({ name: 'Site B' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already uses that name/);
  });

  it("refuses to rename another organisation's site", async () => {
    const a = await createWorld();
    const b = await createWorld();
    const res = await request(app).put(`/api/sites/rename/${b.site._id}`)
      .set(bearer(a.owner.token)).send({ name: 'Hijacked' });
    expect(res.status).toBe(404);
  });

  it('is refused to a manager', async () => {
    const { manager, site } = await createWorld();
    const res = await request(app).put(`/api/sites/rename/${site._id}`)
      .set(bearer(manager.token)).send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });
});

describe('site creation', () => {
  it('creates materials with per-material thresholds and prices', async () => {
    const { owner } = await createWorld();
    const res = await request(app).post('/api/sites/create').set(bearer(owner.token)).send({
      name: 'New Site',
      location: 'Pune',
      materials: [
        { name: 'Cement', quantity: 200, unit: 'bags', low_stock_threshold: 40, unit_cost: 380 },
        'Sand',
      ],
    });

    expect(res.status).toBe(200);
    const items = await Inventory.find({ site_name: 'New Site' }).sort({ name: 1 }).lean();
    expect(items).toHaveLength(2);
    expect(items[0].low_stock_threshold).toBe(40);
    expect(items[0].unit_cost).toBe(380);
    expect(items[1].low_stock_threshold).toBe(50); // the default still applies
    expect(items[0].site_id).not.toBeNull();
  });

  it('refuses a duplicate site name in the same organisation', async () => {
    const { owner, site } = await createWorld();
    const res = await request(app).post('/api/sites/create').set(bearer(owner.token)).send({ name: site.name });
    expect(res.status).toBe(400);
  });
});
