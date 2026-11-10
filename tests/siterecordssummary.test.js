const request = require('supertest');
const app = require('../server');
const { createWorld, createSite, createManager, bearer } = require('./helpers/factories');

// v2: the owner's view across every site — the owner home card and its
// breakdown. Totals leave out void entries, every site is listed even when
// nothing was recorded there, and only an owner may ask.

const pay = (token, body) => request(app).post('/api/payments').set(bearer(token))
  .send({ category: 'labour', amount: 100, paid_to: 'Someone', ...body });
const arrive = (token, body) => request(app).post('/api/arrivals').set(bearer(token))
  .send({ material_name: 'Sand', vehicle_type: 'tipper', vehicle_number: 'KA01', length: 10, breadth: 6, height: 2, dimension_unit: 'ft', ...body });
const summary = (token, query = '') => request(app).get(`/api/site-records/summary${query}`).set(bearer(token));

async function threeSites() {
  const world = await createWorld();                       // "Site A" + its manager
  const siteB = await createSite(world.org, 'Site B');
  const managerB = await createManager(world.org, siteB);
  await createSite(world.org, 'Site C');                   // nothing ever recorded here
  return { ...world, siteB, managerB };
}

describe('site records summary across every site (v2)', () => {
  it('totals payments and arrivals for the whole company and site by site', async () => {
    const { owner, manager, managerB } = await threeSites();
    await pay(manager.token, { category: 'labour', amount: 1000 });
    await pay(manager.token, { category: 'material', amount: 2000.5 });
    await pay(managerB.token, { category: 'material', amount: 500 });
    await arrive(manager.token, {});                                    // 120 cft sand
    await arrive(managerB.token, { material_name: 'Gitti 20mm', height: 2.5 }); // 150 cft
    await arrive(managerB.token, { material_name: 'sand' });           // 120 cft, other spelling

    const res = await summary(owner.token);
    expect(res.status).toBe(200);
    const { totals, by_category: byCategory, by_material: byMaterial, sites } = res.body.data;

    expect(totals).toMatchObject({
      payments_amount: 3500.5, payments_count: 3,
      arrivals_count: 3, arrivals_cft: 390, arrivals_brass: 3.9,
      site_count: 3, active_site_count: 2,
    });
    expect(byCategory).toEqual([
      { category: 'material', total: 2500.5, count: 2 },
      { category: 'labour', total: 1000, count: 1 },
    ]);
    // "Sand" and "sand" are one material in the company total.
    expect(byMaterial.map((m) => [m.material_name, m.volume_cft, m.count])).toEqual([
      ['Sand', 240, 2],
      ['Gitti 20mm', 150, 1],
    ]);

    expect(sites.map((s) => s.site_name)).toEqual(['Site A', 'Site B', 'Site C']);
    const [a, b, c] = sites;
    expect(a).toMatchObject({ payments_amount: 3000.5, payments_count: 2, arrivals_count: 1, arrivals_cft: 120 });
    expect(a.by_category.map((x) => x.category)).toEqual(['material', 'labour']);
    expect(b).toMatchObject({ payments_amount: 500, payments_count: 1, arrivals_count: 2, arrivals_cft: 270 });
    expect(b.by_material.map((m) => m.material_name)).toEqual(['Gitti 20mm', 'sand']);
    expect(c).toMatchObject({ payments_amount: 0, payments_count: 0, arrivals_count: 0, by_category: [], by_material: [] });
  });

  it('leaves out void entries', async () => {
    const { owner, manager } = await createWorld();
    await pay(manager.token, { amount: 700 });
    const wrong = await pay(manager.token, { amount: 99999 });
    const wrongLoad = await arrive(manager.token, {});
    await request(app).put(`/api/payments/void/${wrong.body.data.id}`).set(bearer(owner.token)).send({ reason: 'Typed wrong' });
    await request(app).put(`/api/arrivals/void/${wrongLoad.body.data.id}`).set(bearer(owner.token)).send({ reason: 'Entered twice' });

    const { totals } = (await summary(owner.token)).body.data;
    expect(totals.payments_amount).toBe(700);
    expect(totals.arrivals_count).toBe(0);
    expect(totals.active_site_count).toBe(1);
  });

  it('bounds payments by the day paid and arrivals by the day they arrived', async () => {
    const { owner, manager } = await createWorld();
    await pay(manager.token, { amount: 300, paid_on: '2026-10-20T06:30:00.000Z' });
    await pay(manager.token, { amount: 400, paid_on: '2026-11-03T06:30:00.000Z' });
    await arrive(manager.token, { received_on: '2026-10-31T06:30:00.000Z' });
    await arrive(manager.token, { received_on: '2026-11-02T06:30:00.000Z', height: 3 });

    const november = (await summary(owner.token, '?from=2026-11-01')).body.data.totals;
    expect(november).toMatchObject({ payments_amount: 400, arrivals_count: 1, arrivals_cft: 180 });

    const october = (await summary(owner.token, '?from=2026-10-01&to=2026-10-31')).body.data.totals;
    expect(october).toMatchObject({ payments_amount: 300, arrivals_count: 1, arrivals_cft: 120 });
  });

  it('is for owners only', async () => {
    const { manager } = await createWorld();
    const res = await summary(manager.token);
    expect(res.status).toBe(403);
  });

  it('counts only the asking organisation', async () => {
    const a = await createWorld();
    const b = await createWorld();
    await pay(a.manager.token, { amount: 5000 });
    await arrive(a.manager.token, {});

    const res = await summary(b.owner.token);
    expect(res.body.data.totals).toMatchObject({ payments_amount: 0, arrivals_count: 0, site_count: 1, active_site_count: 0 });
    expect(res.body.data.sites).toHaveLength(1);
  });

  it('refuses a date it cannot read', async () => {
    const { owner } = await createWorld();
    const res = await summary(owner.token, '?from=last-tuesday');
    expect(res.status).toBe(400);
  });

  it('shows the current name of a renamed site', async () => {
    const { owner, manager, site } = await createWorld();
    await pay(manager.token, { amount: 250 });
    await request(app).put(`/api/sites/rename/${site._id}`).set(bearer(owner.token)).send({ name: 'Tower 2' });

    const { sites } = (await summary(owner.token)).body.data;
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ site_name: 'Tower 2', payments_amount: 250 });
  });
});
