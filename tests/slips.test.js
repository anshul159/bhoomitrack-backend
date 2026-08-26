const request = require('supertest');
const app = require('../server');
const Slip = require('../models/Slip');
const Inventory = require('../models/Inventory');
const AuditLog = require('../models/AuditLog');
const { createWorld, createSite, createManager, createInventory, bearer } = require('./helpers/factories');

// The money path. A bug anywhere in here costs a customer real material, so
// these are the tests that have to hold.
describe('slips', () => {
  describe('POST /api/slips/generate', () => {
    it('creates a pending slip without touching stock', async () => {
      const { site, manager, item } = await createWorld();

      const res = await request(app)
        .post('/api/slips/generate')
        .set(bearer(manager.token))
        .send({ site_name: site.name, items: [{ inventory_id: item._id, quantity_taken: 20 }] });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('pending');

      // Stock is untouched until an owner approves — this is the whole point of
      // the pending state.
      const after = await Inventory.findById(item._id);
      expect(after.quantity).toBe(100);
    });

    it('rejects a quantity greater than the stock on hand', async () => {
      const { site, manager, item } = await createWorld();

      const res = await request(app)
        .post('/api/slips/generate')
        .set(bearer(manager.token))
        .send({ site_name: site.name, items: [{ inventory_id: item._id, quantity_taken: 500 }] });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Only 100 bags of Cement in stock/);
      expect(await Slip.countDocuments()).toBe(0);
    });

    it('refuses a slip filed against a site the manager does not hold', async () => {
      const { org, manager } = await createWorld();
      const otherSite = await createSite(org, 'Site B');
      const otherItem = await createInventory(org, otherSite);

      const res = await request(app)
        .post('/api/slips/generate')
        .set(bearer(manager.token))
        .send({ site_name: otherSite.name, items: [{ inventory_id: otherItem._id, quantity_taken: 5 }] });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/not assigned/i);
    });

    it('ignores items belonging to a different site', async () => {
      const { org, site, manager, item } = await createWorld();
      const otherSite = await createSite(org, 'Site B');
      const foreignItem = await createInventory(org, otherSite, { name: 'Steel' });

      const res = await request(app)
        .post('/api/slips/generate')
        .set(bearer(manager.token))
        .send({
          site_name: site.name,
          items: [
            { inventory_id: item._id, quantity_taken: 10 },
            { inventory_id: foreignItem._id, quantity_taken: 10 },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].material_name).toBe('Cement');
    });

    it('captures unit cost at slip time so a later price change cannot rewrite history', async () => {
      const { org, site, manager } = await createWorld();
      const priced = await createInventory(org, site, { name: 'Steel', unit_cost: 50, quantity: 100 });

      const res = await request(app)
        .post('/api/slips/generate')
        .set(bearer(manager.token))
        .send({ site_name: site.name, items: [{ inventory_id: priced._id, quantity_taken: 4 }] });

      expect(res.body.data.items[0].line_total).toBe(200);
      expect(res.body.data.total_value).toBe(200);

      await Inventory.findByIdAndUpdate(priced._id, { unit_cost: 999 });
      const slip = await Slip.findById(res.body.data.id);
      expect(slip.items[0].unit_cost).toBe(50);
      expect(slip.total_value).toBe(200);
    });

    it('leaves value null when nothing on the slip is priced', async () => {
      const { site, manager, item } = await createWorld();
      const res = await request(app)
        .post('/api/slips/generate')
        .set(bearer(manager.token))
        .send({ site_name: site.name, items: [{ inventory_id: item._id, quantity_taken: 1 }] });

      // Unpriced is "unknown", never zero — a zero would read as free material.
      expect(res.body.data.total_value).toBeNull();
    });
  });

  describe('PUT /api/slips/approve/:id', () => {
    async function pendingSlip() {
      const world = await createWorld();
      const res = await request(app)
        .post('/api/slips/generate')
        .set(bearer(world.manager.token))
        .send({ site_name: world.site.name, items: [{ inventory_id: world.item._id, quantity_taken: 20 }] });
      return { ...world, slipId: res.body.data.id };
    }

    it('deducts stock exactly once', async () => {
      const { owner, item, slipId } = await pendingSlip();

      const res = await request(app).put(`/api/slips/approve/${slipId}`).set(bearer(owner.token));
      expect(res.status).toBe(200);

      const after = await Inventory.findById(item._id);
      expect(after.quantity).toBe(80);
    });

    it('does not deduct twice when two approvals race', async () => {
      const { owner, item, slipId } = await pendingSlip();

      // The atomic pending → approved claim is what makes this safe; without it
      // both requests would deduct and the site would lose 40 bags, not 20.
      const [a, b] = await Promise.all([
        request(app).put(`/api/slips/approve/${slipId}`).set(bearer(owner.token)),
        request(app).put(`/api/slips/approve/${slipId}`).set(bearer(owner.token)),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 400]);

      const after = await Inventory.findById(item._id);
      expect(after.quantity).toBe(80);
    });

    it('refuses to approve an already-decided slip', async () => {
      const { owner, slipId } = await pendingSlip();
      await request(app).put(`/api/slips/approve/${slipId}`).set(bearer(owner.token));

      const again = await request(app).put(`/api/slips/approve/${slipId}`).set(bearer(owner.token));
      expect(again.status).toBe(400);
      expect(again.body.message).toMatch(/already approved/);
    });

    it('refuses approval by a manager', async () => {
      const { manager, slipId } = await pendingSlip();
      const res = await request(app).put(`/api/slips/approve/${slipId}`).set(bearer(manager.token));
      expect(res.status).toBe(403);
    });

    it('writes an audit row naming who approved it', async () => {
      const { owner, slipId } = await pendingSlip();
      await request(app).put(`/api/slips/approve/${slipId}`).set(bearer(owner.token));

      const entry = await AuditLog.findOne({ action: 'slip.approve' });
      expect(entry).not.toBeNull();
      expect(String(entry.actor_id)).toBe(String(owner.user._id));
      expect(entry.before).toEqual({ status: 'pending' });
    });

    it('records the rejection without touching stock', async () => {
      const { owner, item, slipId } = await pendingSlip();
      const res = await request(app).put(`/api/slips/reject/${slipId}`).set(bearer(owner.token));

      expect(res.status).toBe(200);
      expect((await Inventory.findById(item._id)).quantity).toBe(100);
      expect(await AuditLog.findOne({ action: 'slip.reject' })).not.toBeNull();
    });
  });

  describe('GET /api/slips/last/:site', () => {
    it("returns the manager's own latest slip, not a colleague's", async () => {
      const { org, site, manager, item } = await createWorld();
      const other = await createManager(org, site, { name: 'Other Manager' });

      await request(app).post('/api/slips/generate').set(bearer(other.token))
        .send({ site_name: site.name, items: [{ inventory_id: item._id, quantity_taken: 5 }] });
      await request(app).post('/api/slips/generate').set(bearer(manager.token))
        .send({ site_name: site.name, items: [{ inventory_id: item._id, quantity_taken: 7 }] });

      const res = await request(app).get(`/api/slips/last/${site.name}`).set(bearer(manager.token));
      expect(res.body.data.manager_name).toBe('Test Manager');
      expect(res.body.data.items[0].quantity_taken).toBe(7);
    });
  });
});
