const request = require('supertest');
const app = require('../server');
const Inventory = require('../models/Inventory');
const AuditLog = require('../models/AuditLog');
const { createWorld, bearer } = require('./helpers/factories');

describe('low-stock threshold (ENH-022)', () => {
  it('accepts a threshold when a material is added', async () => {
    const { owner, site } = await createWorld();

    const res = await request(app).post('/api/inventory/add').set(bearer(owner.token)).send({
      name: 'Steel', quantity: 10, unit: 'tonnes', site_name: site.name, low_stock_threshold: 2,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.low_stock_threshold).toBe(2);
  });

  it('still defaults to 50 when none is given', async () => {
    const { owner, site } = await createWorld();
    const res = await request(app).post('/api/inventory/add').set(bearer(owner.token))
      .send({ name: 'Sand', quantity: 10, unit: 'loads', site_name: site.name });
    expect(res.body.data.low_stock_threshold).toBe(50);
  });

  it('lets an owner change the threshold afterwards', async () => {
    const { owner, item } = await createWorld();

    // This is the case that used to be impossible: PUT read `quantity` alone.
    const res = await request(app).put(`/api/inventory/update/${item._id}`)
      .set(bearer(owner.token)).send({ low_stock_threshold: 5 });

    expect(res.status).toBe(200);
    expect(res.body.data.low_stock_threshold).toBe(5);
    expect((await Inventory.findById(item._id)).quantity).toBe(100); // untouched
  });

  it('updates quantity and threshold independently', async () => {
    const { owner, item } = await createWorld();

    await request(app).put(`/api/inventory/update/${item._id}`).set(bearer(owner.token)).send({ quantity: 30 });
    let stored = await Inventory.findById(item._id);
    expect(stored.quantity).toBe(30);
    expect(stored.low_stock_threshold).toBe(50);

    await request(app).put(`/api/inventory/update/${item._id}`).set(bearer(owner.token)).send({ low_stock_threshold: 10 });
    stored = await Inventory.findById(item._id);
    expect(stored.quantity).toBe(30);
    expect(stored.low_stock_threshold).toBe(10);
  });

  it('drives the is_low flag from the per-material value', async () => {
    const { owner, site, item } = await createWorld();
    await request(app).put(`/api/inventory/update/${item._id}`)
      .set(bearer(owner.token)).send({ quantity: 60, low_stock_threshold: 80 });

    const res = await request(app).get(`/api/inventory/${site.name}`).set(bearer(owner.token));
    expect(res.body.data.find((i) => i.id === String(item._id)).is_low).toBe(true);
  });

  it('rejects a negative threshold', async () => {
    const { owner, item } = await createWorld();
    const res = await request(app).put(`/api/inventory/update/${item._id}`)
      .set(bearer(owner.token)).send({ low_stock_threshold: -1 });
    expect(res.status).toBe(400);
  });

  it('refuses an update from a manager', async () => {
    const { manager, item } = await createWorld();
    const res = await request(app).put(`/api/inventory/update/${item._id}`)
      .set(bearer(manager.token)).send({ quantity: 1 });
    expect(res.status).toBe(403);
  });
});

describe('inventory audit trail (ENH-008)', () => {
  it('records the previous and new value of a direct stock edit', async () => {
    const { owner, item } = await createWorld();

    await request(app).put(`/api/inventory/update/${item._id}`).set(bearer(owner.token))
      .send({ quantity: 42, reason: 'Recount after delivery' });

    const entry = await AuditLog.findOne({ action: 'inventory.update' });
    expect(entry.before.quantity).toBe(100);
    expect(entry.after.quantity).toBe(42);
    expect(entry.entity_label).toBe('Cement');
    expect(entry.actor_name).toBe('Test Owner');
    // `reason` was a field the app already sent and the API silently discarded.
    expect(entry.note).toBe('Recount after delivery');
  });

  it('does not write a row when nothing actually changed', async () => {
    const { owner, item } = await createWorld();
    await request(app).put(`/api/inventory/update/${item._id}`).set(bearer(owner.token)).send({ quantity: 100 });
    expect(await AuditLog.countDocuments({ action: 'inventory.update' })).toBe(0);
  });

  it('records creation and deletion', async () => {
    const { owner, site } = await createWorld();
    const created = await request(app).post('/api/inventory/add').set(bearer(owner.token))
      .send({ name: 'Bricks', quantity: 500, unit: 'pcs', site_name: site.name });

    await request(app).delete(`/api/inventory/delete/${created.body.data.id}`).set(bearer(owner.token));

    expect(await AuditLog.findOne({ action: 'inventory.create', entity_label: 'Bricks' })).not.toBeNull();
    const deleted = await AuditLog.findOne({ action: 'inventory.delete', entity_label: 'Bricks' });
    expect(deleted.before.quantity).toBe(500);
  });

  it('exposes an entity history to the owner', async () => {
    const { owner, item } = await createWorld();
    await request(app).put(`/api/inventory/update/${item._id}`).set(bearer(owner.token)).send({ quantity: 90 });
    await request(app).put(`/api/inventory/update/${item._id}`).set(bearer(owner.token)).send({ quantity: 80 });

    const res = await request(app).get(`/api/audit/entity/inventory/${item._id}`).set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].after.quantity).toBe(80); // newest first
  });

  it('is not readable by a manager', async () => {
    const { manager } = await createWorld();
    const res = await request(app).get('/api/audit').set(bearer(manager.token));
    expect(res.status).toBe(403);
  });
});

describe('unit cost (ENH-017)', () => {
  it('stores a price and reports stock value', async () => {
    const { owner, site } = await createWorld();
    await request(app).post('/api/inventory/add').set(bearer(owner.token))
      .send({ name: 'Steel', quantity: 10, unit: 'tonnes', site_name: site.name, unit_cost: 5000 });

    const res = await request(app).get('/api/reports/analytics').set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data.value.stock_on_hand).toBe(50000);
    // The Cement fixture has no price, and the report says so rather than
    // treating it as free.
    expect(res.body.data.value.unpriced_materials).toBe(1);
    expect(res.body.data.value.priced_materials).toBe(1);
  });

  it('rejects a negative price', async () => {
    const { owner, item } = await createWorld();
    const res = await request(app).put(`/api/inventory/update/${item._id}`)
      .set(bearer(owner.token)).send({ unit_cost: -5 });
    expect(res.status).toBe(400);
  });
});
