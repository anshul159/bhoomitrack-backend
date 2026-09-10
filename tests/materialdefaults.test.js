const request = require('supertest');
const app = require('../server');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { createWorld, bearer } = require('./helpers/factories');
const { MAX_MATERIALS, MATERIAL_NAME_MAX, UNITS } = require('../utils/materialDefaults');

const GET = '/api/users/me/material-defaults';

describe('create-site material defaults', () => {
  let world;
  beforeEach(async () => { world = await createWorld(); });

  it('seeds the built-in twelve for a user who has never configured them', async () => {
    const res = await request(app).get(GET).set(bearer(world.owner.token));

    expect(res.status).toBe(200);
    expect(res.body.defaults).toHaveLength(12);
    expect(res.body.defaults.map((m) => m.name)).toEqual([
      'Brick', 'Cement', 'Gitti', 'Iron Rod', 'Plywood', 'Rock',
      'Sand', 'Soil', 'Steel', 'Paint', 'Tiles', 'Glass',
    ]);
    expect(res.body.units).toEqual(UNITS);
  });

  // The whole reason the form was worth changing: nothing should arrive ticked
  // because of an upgrade. A site created straight after installing must contain
  // exactly the materials its owner chose.
  it('seeds nothing as preselected', async () => {
    const res = await request(app).get(GET).set(bearer(world.owner.token));
    expect(res.body.defaults.every((m) => m.preselected === false)).toBe(true);
  });

  it('stores a list and hands it back', async () => {
    const defaults = [
      { name: 'Cement', unit: 'bags', preselected: true },
      { name: 'Sand', unit: 'brass', preselected: false },
    ];

    const put = await request(app).put(GET).set(bearer(world.owner.token)).send({ defaults });
    expect(put.status).toBe(200);
    expect(put.body.defaults).toEqual(defaults);

    const get = await request(app).get(GET).set(bearer(world.owner.token));
    expect(get.body.defaults).toEqual(defaults);
  });

  // The distinction the model's `default: undefined` exists to preserve: a user who
  // deleted every row wants an empty form, not the twelve back.
  it('honours a deliberately emptied list instead of re-seeding', async () => {
    await request(app).put(GET).set(bearer(world.owner.token)).send({ defaults: [] });

    const res = await request(app).get(GET).set(bearer(world.owner.token));
    expect(res.status).toBe(200);
    expect(res.body.defaults).toEqual([]);

    const stored = await User.findById(world.owner.user._id).lean();
    expect(stored.materialDefaults).toEqual([]);
  });

  it('defaults a missing unit to units and a missing flag to false', async () => {
    const res = await request(app)
      .put(GET).set(bearer(world.owner.token))
      .send({ defaults: [{ name: 'Concrete' }] });

    expect(res.body.defaults).toEqual([{ name: 'Concrete', unit: 'units', preselected: false }]);
  });

  it('trims names and drops case-insensitive duplicates, keeping the first', async () => {
    const res = await request(app)
      .put(GET).set(bearer(world.owner.token))
      .send({ defaults: [
        { name: '  Cement  ', unit: 'bags', preselected: true },
        { name: 'cement', unit: 'kg' },
      ] });

    expect(res.body.defaults).toEqual([{ name: 'Cement', unit: 'bags', preselected: true }]);
  });

  it('rejects a nameless material', async () => {
    const res = await request(app)
      .put(GET).set(bearer(world.owner.token))
      .send({ defaults: [{ name: '   ', unit: 'bags' }] });

    expect(res.status).toBe(400);
  });

  it('rejects a name longer than the cap', async () => {
    const res = await request(app)
      .put(GET).set(bearer(world.owner.token))
      .send({ defaults: [{ name: 'x'.repeat(MATERIAL_NAME_MAX + 1) }] });

    expect(res.status).toBe(400);
  });

  it('rejects a payload that is not an array', async () => {
    const res = await request(app)
      .put(GET).set(bearer(world.owner.token))
      .send({ defaults: { name: 'Cement' } });

    expect(res.status).toBe(400);
  });

  it('bounds the list so the user document cannot grow without limit', async () => {
    const defaults = Array.from({ length: MAX_MATERIALS + 1 }, (_, i) => ({ name: `M${i}` }));
    const res = await request(app).put(GET).set(bearer(world.owner.token)).send({ defaults });

    expect(res.status).toBe(400);
  });

  // A unit the picker does not offer still has to work: POST /api/sites/create has
  // always accepted any unit string, and a firm measuring in something we did not
  // think of must not be told their own vocabulary is invalid.
  it('accepts a unit outside the suggested list', async () => {
    const res = await request(app)
      .put(GET).set(bearer(world.owner.token))
      .send({ defaults: [{ name: 'Murum', unit: 'trolleys' }] });

    expect(res.status).toBe(200);
    expect(res.body.defaults[0].unit).toBe('trolleys');
  });

  it('is per user, not per organisation', async () => {
    await request(app)
      .put(GET).set(bearer(world.owner.token))
      .send({ defaults: [{ name: 'Cement', unit: 'bags', preselected: true }] });

    const managerRes = await request(app).get(GET).set(bearer(world.manager.token));
    expect(managerRes.status).toBe(200);
    expect(managerRes.body.defaults).toHaveLength(12);
  });

  it('needs a token', async () => {
    expect((await request(app).get(GET)).status).toBe(401);
    expect((await request(app).put(GET).send({ defaults: [] })).status).toBe(401);
  });

  it('records the change as counts rather than material names', async () => {
    await request(app)
      .put(GET).set(bearer(world.owner.token))
      .send({ defaults: [{ name: 'Cement' }, { name: 'Sand' }] });

    const entry = await AuditLog.findOne({ action: 'user.material_defaults.set' }).lean();
    expect(entry).toBeTruthy();
    expect(entry.before).toEqual({ materials: null });
    expect(entry.after).toEqual({ materials: 2 });
  });
});
