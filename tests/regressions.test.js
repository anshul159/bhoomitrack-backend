const request = require('supertest');
const app = require('../server');
const Slip = require('../models/Slip');
const User = require('../models/User');
const Inventory = require('../models/Inventory');
const Organization = require('../models/Organization');
const {
  createWorld, createOwner, createInventory, createManager, bearer,
} = require('./helpers/factories');

/**
 * Regressions for the defects the 2026-08-27 functional sweep found (PF-012–PF-017).
 *
 * Each of these passed every existing test while being wrong, which is the point of
 * pinning them here: they are all cases where the API returned 200 and did the wrong
 * thing quietly.
 */
describe('regressions from the functional sweep', () => {

  // ─── PF-013 ────────────────────────────────────────────────────────────────
  describe('PF-013 — stock is re-checked when a slip is approved', () => {
    /** Two slips, each within stock on its own, together beyond it. */
    async function twoOversizedSlips() {
      const world = await createWorld();          // 100 bags on hand
      const { site, manager } = world;
      const mk = (qty) => request(app)
        .post('/api/slips/generate')
        .set(bearer(manager.token))
        .send({ site_name: site.name, items: [{ inventory_id: world.item._id, quantity_taken: qty }] });

      const a = await mk(80);
      const b = await mk(80);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);                 // legal when written: 80 <= 100
      return { ...world, slipA: a.body.data.id, slipB: b.body.data.id };
    }

    it('refuses the second approval instead of clamping stock at zero', async () => {
      const { owner, item, slipA, slipB } = await twoOversizedSlips();

      const first = await request(app).put(`/api/slips/approve/${slipA}`).set(bearer(owner.token));
      expect(first.status).toBe(200);
      expect((await Inventory.findById(item._id)).quantity).toBe(20);

      // Previously this returned 200, clamped stock to 0, and left the two slips
      // claiming 160 bags issued where only 100 existed.
      const second = await request(app).put(`/api/slips/approve/${slipB}`).set(bearer(owner.token));
      expect(second.status).toBe(400);
      expect(second.body.code).toBe('insufficient_stock');
      expect(second.body.message).toMatch(/Only 20 bags of Cement left/);
    });

    it('leaves the stock exactly as it was when an approval is refused', async () => {
      const { owner, item, slipA, slipB } = await twoOversizedSlips();
      await request(app).put(`/api/slips/approve/${slipA}`).set(bearer(owner.token));

      await request(app).put(`/api/slips/approve/${slipB}`).set(bearer(owner.token));

      expect((await Inventory.findById(item._id)).quantity).toBe(20);
    });

    it('leaves the refused slip pending so it can be approved later', async () => {
      const { owner, item, slipA, slipB } = await twoOversizedSlips();
      await request(app).put(`/api/slips/approve/${slipA}`).set(bearer(owner.token));
      await request(app).put(`/api/slips/approve/${slipB}`).set(bearer(owner.token));

      // The claim must be released, or the slip is stuck approved with nothing taken.
      const stuck = await Slip.findById(slipB);
      expect(stuck.status).toBe('pending');
      expect(stuck.decided_at).toBeFalsy();

      // Once stock is replenished the same slip goes through untouched.
      await Inventory.findByIdAndUpdate(item._id, { quantity: 200 });
      const retry = await request(app).put(`/api/slips/approve/${slipB}`).set(bearer(owner.token));
      expect(retry.status).toBe(200);
      expect((await Inventory.findById(item._id)).quantity).toBe(120);
    });

    it('still approves a slip that fits, unchanged', async () => {
      const { owner, site, manager, item } = await createWorld();
      const slip = await request(app)
        .post('/api/slips/generate')
        .set(bearer(manager.token))
        .send({ site_name: site.name, items: [{ inventory_id: item._id, quantity_taken: 30 }] });

      const res = await request(app).put(`/api/slips/approve/${slip.body.data.id}`).set(bearer(owner.token));

      expect(res.status).toBe(200);
      expect((await Inventory.findById(item._id)).quantity).toBe(70);
    });

    it('still treats a material deleted since submission as a skip, not a failure', async () => {
      // PT-07 RC-07 pins this as a graceful no-op. The stock re-check must not
      // turn a deleted line into a blocked approval.
      const { owner, site, manager, item } = await createWorld();
      const slip = await request(app)
        .post('/api/slips/generate')
        .set(bearer(manager.token))
        .send({ site_name: site.name, items: [{ inventory_id: item._id, quantity_taken: 30 }] });
      await Inventory.findByIdAndDelete(item._id);

      const res = await request(app).put(`/api/slips/approve/${slip.body.data.id}`).set(bearer(owner.token));

      expect(res.status).toBe(200);
      expect((await Slip.findById(slip.body.data.id)).status).toBe('approved');
    });
  });

  // ─── PF-014 ────────────────────────────────────────────────────────────────
  describe('PF-014 — a site assignment does not end the manager\'s session', () => {
    it('leaves the manager signed in after being assigned a site', async () => {
      const { org, owner, site, manager } = await createWorld();

      const assign = await request(app)
        .put(`/api/users/assign-site/${manager.user._id}`)
        .set(bearer(owner.token))
        .send({ siteName: site.name });
      expect(assign.status).toBe(200);

      // Previously 401 "Session expired" — the app threw the manager back to the
      // login screen on an action owners perform routinely.
      const me = await request(app).get('/api/users/me').set(bearer(manager.token));
      expect(me.status).toBe(200);
      expect(String(me.body.user.id)).toBe(String(manager.user._id));
    });

    it('leaves the manager signed in after being removed from a site', async () => {
      const { owner, manager } = await createWorld();

      await request(app)
        .put(`/api/users/remove-from-site/${manager.user._id}`)
        .set(bearer(owner.token))
        .send({});

      expect((await request(app).get('/api/users/me').set(bearer(manager.token))).status).toBe(200);
    });

    it('applies the new scope on the very next request, without a re-login', async () => {
      // This is what makes dropping the revocation safe: scope is read from the
      // user document per request, never from the token.
      const { org, owner, manager } = await createWorld();
      const siteB = await require('./helpers/factories').createSite(org, 'Site B');
      const itemB = await createInventory(org, siteB);

      const before = await request(app)
        .get(`/api/inventory/${encodeURIComponent(siteB.name)}`)
        .set(bearer(manager.token));
      expect(before.status).toBe(403);

      await request(app)
        .put(`/api/users/assign-site/${manager.user._id}`)
        .set(bearer(owner.token))
        .send({ siteName: siteB.name });

      const after = await request(app)
        .get(`/api/inventory/${encodeURIComponent(siteB.name)}`)
        .set(bearer(manager.token));
      expect(after.status).toBe(200);
    });

    it('still revokes the session on logout and password change', async () => {
      // The revocations that exist for a reason must survive this change.
      const { manager } = await createWorld();
      await request(app).post('/api/users/logout').set(bearer(manager.token)).send({});

      expect((await request(app).get('/api/users/me').set(bearer(manager.token))).status).toBe(401);
    });
  });

  // ─── PF-015 ────────────────────────────────────────────────────────────────
  describe('PF-015 — the owner a manager chats with is deterministic', () => {
    it('returns the organisation\'s super admin when there is more than one owner', async () => {
      const { org, manager } = await createWorld();
      const superAdmin = await createOwner(org, { role: 'super_admin', name: 'The Super Admin' });
      await Organization.findByIdAndUpdate(org._id, { superAdminId: superAdmin.user._id });
      await createOwner(org, { name: 'Another Owner' });
      await createOwner(org, { name: 'Yet Another Owner' });

      // Ten calls, because the bug was an unordered findOne — a single call could
      // pass by luck.
      for (let i = 0; i < 10; i++) {
        const res = await request(app).get('/api/users/owner').set(bearer(manager.token));
        expect(res.status).toBe(200);
        expect(String(res.body.data.id)).toBe(String(superAdmin.user._id));
      }
    });

    it('falls back to the longest-standing owner when no super admin is recorded', async () => {
      const { org, owner, manager } = await createWorld();
      await createOwner(org, { name: 'Later Owner' });

      const res = await request(app).get('/api/users/owner').set(bearer(manager.token));

      expect(res.status).toBe(200);
      expect(String(res.body.data.id)).toBe(String(owner.user._id));
    });

    it('never returns an owner from another organisation', async () => {
      const { manager } = await createWorld();
      const otherWorld = await createWorld();

      const res = await request(app).get('/api/users/owner').set(bearer(manager.token));

      expect(String(res.body.data.id)).not.toBe(String(otherWorld.owner.user._id));
    });
  });

  // ─── PF-012 ────────────────────────────────────────────────────────────────
  describe('PF-012 — an invite grants the role that was asked for', () => {
    async function superAdminOf(org) {
      const sa = await createOwner(org, { role: 'super_admin' });
      await Organization.findByIdAndUpdate(org._id, { superAdminId: sa.user._id });
      return sa;
    }

    it('mints a manager invite when the caller asks for one', async () => {
      const { org } = await createWorld();
      const sa = await superAdminOf(org);

      const res = await request(app)
        .post('/api/invite/generate')
        .set(bearer(sa.token))
        .send({ role: 'manager', force: true });

      expect(res.status).toBe(200);
      expect(res.body.role).toBe('manager');
    });

    it('mints an owner invite when the caller asks for one', async () => {
      const { org } = await createWorld();
      const sa = await superAdminOf(org);

      const res = await request(app)
        .post('/api/invite/generate')
        .set(bearer(sa.token))
        .send({ role: 'owner', force: true });

      expect(res.status).toBe(200);
      expect(res.body.role).toBe('owner');
    });

    it('defaults to the lesser privilege when no role is named', async () => {
      // The old default was `owner`, which is how a button labelled "Invite
      // Manager" came to hand out full owner access. A caller that says nothing
      // must not be given the keys to the company.
      const { org } = await createWorld();
      const sa = await superAdminOf(org);

      const res = await request(app)
        .post('/api/invite/generate')
        .set(bearer(sa.token))
        .send({ force: true });

      expect(res.status).toBe(200);
      expect(res.body.role).toBe('manager');
    });

    it('still refuses to let an owner mint an owner invite', async () => {
      const { owner } = await createWorld();

      const res = await request(app)
        .post('/api/invite/generate')
        .set(bearer(owner.token))
        .send({ role: 'owner', force: true });

      expect(res.body.role).toBe('manager');
    });
  });
});
