#!/usr/bin/env node
/**
 * Seeds one realistic organisation: Ruby Constructions.
 *
 * Writes to whatever MONGODB_URI points at — which is PRODUCTION. It refuses to
 * run if the organisation already exists rather than making a second one, because
 * PF-002's unique index would reject duplicate sites halfway through and leave a
 * half-built org behind.
 *
 * "Realistic" here means the reports have something true to say: a year of slips
 * on a rising-then-falling curve, restocking through accepted material requests,
 * a queue of undecided work, two quiet sites, idle stock at one site that another
 * site is short of, and one material with no price so the honesty fields have a
 * reason to appear.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const APPLY = process.argv.includes('--yes');
const ORG_NAME = 'Ruby Constructions';
const PASSWORD = 'Admin@123';
// Overridable, because prernarhea1@gmail.com is already an owner in "Manas" and
// a user belongs to exactly one organisation.
const EMAIL = (process.argv.find((a) => a.startsWith('--email=')) || '').split('=')[1]
  || 'prernarhea1@gmail.com';

if (!process.env.MONGODB_URI) { console.error('❌ MONGODB_URI is not set.'); process.exit(1); }

const day = (n) => new Date(Date.now() - n * 86400000);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// Unit costs are the organisation's own; they are what makes every rupee figure
// in the reports real rather than decorative.
const CATALOGUE = [
  { name: 'Cement (OPC 53)',      unit: 'bags',   cost: 380,   low: 100, phase: 'structure' },
  { name: 'TMT Steel Fe500',      unit: 'tonnes', cost: 62000, low: 3,   phase: 'structure' },
  { name: 'River Sand',           unit: 'cft',    cost: 45,    low: 200, phase: 'structure' },
  { name: '20mm Aggregate',       unit: 'cft',    cost: 38,    low: 200, phase: 'structure' },
  { name: 'Red Bricks',           unit: 'nos',    cost: 9,     low: 3000,phase: 'masonry' },
  { name: 'AAC Blocks',           unit: 'nos',    cost: 48,    low: 500, phase: 'masonry' },
  { name: 'RMC M25',              unit: 'cum',    cost: 4800,  low: 10,  phase: 'structure' },
  { name: 'Binding Wire',         unit: 'kg',     cost: 78,    low: 40,  phase: 'structure' },
  { name: 'Shuttering Ply',       unit: 'nos',    cost: 1250,  low: 20,  phase: 'structure' },
  { name: 'Waterproofing Compound', unit: 'ltr',  cost: 185,   low: 50,  phase: 'finishing' },
  { name: 'Vitrified Tiles',      unit: 'sqft',   cost: 65,    low: 400, phase: 'finishing' },
  { name: 'Emulsion Paint',       unit: 'ltr',    cost: 240,   low: 60,  phase: 'finishing' },
  { name: 'PVC Pipes 4in',        unit: 'nos',    cost: 410,   low: 30,  phase: 'services' },
  { name: 'Electrical Conduit',   unit: 'nos',    cost: 95,    low: 100, phase: 'services' },
  // Deliberately unpriced: the reports must show it as "—" and count it as
  // unpriced rather than treating it as free (ENH-017's honesty rule).
  { name: 'Site Consumables',     unit: 'lot',    cost: null,  low: 10,  phase: 'services' },
];

// Twenty sites, each with its OWN start date. That stagger is what makes the
// analytics worth exploring: an eleven-month site is in finishing while a
// two-month site is still pouring structure, so spend, cover and burn rate all
// differ for reasons a real owner would recognise.
//
// `age` is months since the site started. Phase follows from it, because a site
// does not choose its phase — its age does.
const SITE_NAMES = [
  ['Ruby Heights, Kharadi',        'Kharadi, Pune',        14, 'high'],
  ['Ruby Enclave, Baner',          'Baner, Pune',          13, 'high'],
  ['Ruby Corporate Park',          'Hinjewadi, Pune',      12, 'high'],
  ['Ruby Row Houses, Wakad',       'Wakad, Pune',          12, 'medium'],
  ['Ruby Residency, Viman Nagar',  'Viman Nagar, Pune',    11, 'high'],
  ['Ruby Arcade, Hadapsar',        'Hadapsar, Pune',       10, 'medium'],
  ['Ruby Greens, Undri',           'Undri, Pune',          10, 'medium'],
  ['Ruby Business Bay, Thane',     'Thane West, Mumbai',    9, 'medium'],
  ['Ruby Villas, Lonavala',        'Lonavala',              8, 'dormant'],
  ['Ruby Plaza, Chinchwad',        'Chinchwad, Pune',       8, 'medium'],
  ['Ruby Skyline, Balewadi',       'Balewadi, Pune',        7, 'high'],
  ['Ruby Meadows, Bavdhan',        'Bavdhan, Pune',         6, 'medium'],
  ['Ruby Crest, Aundh',            'Aundh, Pune',           6, 'low'],
  ['Ruby Orchid, Magarpatta',      'Magarpatta, Pune',      5, 'medium'],
  ['Ruby Sapphire, Kalyani Nagar', 'Kalyani Nagar, Pune',   4, 'high'],
  ['Ruby Emerald, Pimpri',         'Pimpri, Pune',          3, 'medium'],
  ['Ruby Topaz, Moshi',            'Moshi, Pune',           3, 'dormant'],
  ['Ruby Pearl, Ravet',            'Ravet, Pune',           2, 'medium'],
  ['Ruby Onyx, Talegaon',          'Talegaon',              1, 'high'],
  ['Ruby Quartz, Chakan',          'Chakan, Pune',          1, 'low'],
];

// Phase from age: structure for the first months, then masonry, then finishing.
const phaseFor = (months) => (months >= 10 ? 'finishing' : months >= 5 ? 'masonry' : 'structure');

const SITES = SITE_NAMES.map(([name, loc, months, activity]) => ({
  name, loc, months, activity, phase: phaseFor(months), days: Math.round(months * 30.44),
}));

const MANAGERS = [
  'Suresh Patil', 'Vikram Joshi', 'Imran Shaikh', 'Ganesh Kadam', 'Ravi Deshmukh',
  'Sandeep More', 'Amit Chavan', 'Nitin Bhosale', 'Prakash Jadhav', 'Mahesh Sawant',
  'Rajesh Gaikwad', 'Anil Pawar', 'Sunil Salunkhe', 'Dattatray Kale', 'Yogesh Thorat',
  'Bhushan Dhole', 'Kiran Waghmare', 'Pravin Shelke', 'Santosh Bhalerao', 'Manoj Ghule',
];
const OWNERS = [
  { name: 'Rohit Mehra',   email: 'rohit.mehra@rubyconstructions.in' },
  { name: 'Kavita Nair',   email: 'kavita.nair@rubyconstructions.in' },
  { name: 'Sanjay Iyer',   email: 'sanjay.iyer@rubyconstructions.in' },
];

// The oldest site sets how far back anything goes; each site only has history
// from its own start date, which is the whole point of the stagger.
const DAYS_HISTORY = Math.max(...SITES.map((s) => s.days));

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Organization = require('./models/Organization');
  const User = require('./models/User');
  const Site = require('./models/Site');
  const Inventory = require('./models/Inventory');
  const Slip = require('./models/Slip');
  const Order = require('./models/Order');

  try {
    const clash = await Organization.findOne({ name: ORG_NAME });
    if (clash) {
      console.error(`❌ "${ORG_NAME}" already exists (${clash._id}). Refusing to make a second one.`);
      process.exitCode = 1; return;
    }
    const emailClash = await User.findOne({ email: EMAIL, deletedAt: null });
    if (emailClash) {
      console.error(`❌ ${EMAIL} already exists (role ${emailClash.role}, org ${emailClash.orgId}).`);
      console.error('   A user belongs to exactly one organisation. Pass --email=<other> instead.');
      process.exitCode = 1; return;
    }

    if (!APPLY) {
      console.log('');
      console.log(`  Would create "${ORG_NAME}":`);
      console.log(`    1 super admin (${EMAIL}), ${OWNERS.length} owners (no web access),`);
      console.log(`    ${SITES.length} sites, ${MANAGERS.length} managers, ~${CATALOGUE.length} materials per site,`);
      console.log(`    ${DAYS_HISTORY} days of slips, restocking orders, and a live approval queue.`);
      console.log('');
      console.log('  Nothing written. Re-run with --yes to apply.');
      console.log('');
      return;
    }

    const hash = await bcrypt.hash(PASSWORD, 10);

    // ── Organisation, on the top tier ───────────────────────────────────────
    const org = await Organization.create({
      name: ORG_NAME,
      plan: 'founding',                 // the highest tier; safe now that main is deployed
      status: 'active',
      currentPeriodEnd: null,           // isActive() is true forever
      trialEndsAt: day(-3650),
      currency: 'INR',
      billing: { cycle: 'lifetime', agreedAt: new Date(), agreedBy: 'seed', note: 'Founding — seeded test account' },
      payments: [{
        amountPaise: 10000000, paidAt: day(400), method: 'bank', reference: 'SEED-FOUNDING',
        periodStart: day(400), periodEnd: null, plan: 'founding', siteCount: SITES.length,
        recordedBy: 'seed', note: 'Founding lifetime',
      }],
    });

    const sa = await User.create({
      name: 'Prerna Rhea', email: EMAIL, password: hash,
      role: 'super_admin', status: 'approved', orgId: org._id,
    });
    await Organization.updateOne({ _id: org._id }, { superAdminId: sa._id });

    // Three owners, none with console access — the super admin grants it.
    await User.insertMany(OWNERS.map((o) => ({
      name: o.name, email: o.email, password: hash,
      role: 'owner', status: 'approved', orgId: org._id, webAppAccess: false,
    })));

    // ── Sites ───────────────────────────────────────────────────────────────
    const sites = [];
    for (const s of SITES) sites.push(await Site.create({ name: s.name, location: s.loc, orgId: org._id, owner_id: sa._id }));

    // ── Managers, one per site ──────────────────────────────────────────────
    const managers = [];
    for (let i = 0; i < SITES.length; i++) {
      managers.push(await User.create({
        name: MANAGERS[i], phone: `9${String(800000000 + i * 111111).slice(0, 9)}`,
        password: hash, role: 'manager', status: 'approved', orgId: org._id,
        site_ids: [sites[i]._id], site_name: sites[i].name, assignedAt: day(SITES[i].days),
      }));
    }
    // One waiting on approval, so the Managers screen has a pending group.
    await User.create({ name: 'Deepak Shinde', phone: '9820011223', password: hash,
      role: 'manager', status: 'pending', orgId: org._id, site_ids: [], site_name: '' });

    // ── Inventory ───────────────────────────────────────────────────────────
    // Each site stocks what its phase actually uses, plus consumables.
    const invDocs = [];
    const stockFor = (site, cat) => {
      const base = { 'bags': 600, 'tonnes': 22, 'cft': 1400, 'nos': 4000, 'cum': 40,
                     'kg': 220, 'ltr': 300, 'sqft': 2500, 'lot': 30 }[cat.unit] || 100;
      return round(base * rnd(0.5, 1.6), cat.unit === 'tonnes' ? 2 : 0);
    };
    for (const [i, s] of SITES.entries()) {
      const mats = CATALOGUE.filter((c) =>
        c.phase === s.phase || c.phase === 'services' || (s.phase === 'finishing' && c.phase === 'masonry'));
      for (const c of mats) {
        let qty = stockFor(s, c);
        // A few deliberate shortages so stockout risk and transfer suggestions
        // have real rows rather than an empty table.
        if (i === 1 && c.name === 'Cement (OPC 53)') qty = 40;
        if (i === 2 && c.name === 'TMT Steel Fe500') qty = 1.5;
        if (i === 5 && c.name === 'AAC Blocks') qty = 0;
        invDocs.push({
          name: c.name, quantity: qty, unit: c.unit, unit_cost: c.cost,
          low_stock_threshold: c.low, site_id: sites[i]._id, site_name: sites[i].name,
          orgId: org._id, createdAt: day(SITES[i].days), updatedAt: day(rnd(0, 20)),
        });
      }
    }
    await Inventory.insertMany(invDocs, { timestamps: false });

    // ── A year and a bit of slips ───────────────────────────────────────────
    const slips = [];
    const orders = [];
    for (const [i, s] of SITES.entries()) {
      const mats = invDocs.filter((d) => d.site_name === sites[i].name);
      const mgr = managers[i];
      // Dormant sites stopped weeks ago; that is what makes them dormant.
      const stopAt = s.activity === 'dormant' ? rnd(28, 60) : 0;
      const perWeek = { high: 5, medium: 3, low: 2, dormant: 2 }[s.activity];

      // From THIS site's start date, not the organisation's oldest. A two-month
      // site with a year of slips would make every comparison a lie.
      for (let d = s.days; d > stopAt; d--) {
        if (Math.random() > perWeek / 7) continue;
        const mat = pick(mats);
        // A season: work ramps up over the first half and eases off late, so the
        // trend and burn-rate charts show a shape rather than noise.
        // Work ramps up and eases off across a site's OWN life, so a young site
        // is still accelerating while an old one is winding down.
        const season = 0.6 + Math.sin((s.days - d) / s.days * Math.PI) * 0.8;
        const qty = round(({ 'bags': 25, 'tonnes': 0.8, 'cft': 90, 'nos': 350, 'cum': 6,
                             'kg': 12, 'ltr': 18, 'sqft': 160, 'lot': 1 }[mat.unit] || 10)
                          * season * rnd(0.5, 1.5), mat.unit === 'tonnes' ? 2 : 0);
        if (qty <= 0) continue;

        const r = Math.random();
        const status = r < 0.86 ? 'approved' : r < 0.94 ? 'rejected' : 'pending';
        const decidedIn = rnd(2, 60) / 24; // hours → days
        const line = mat.unit_cost === null ? null : round(qty * mat.unit_cost);
        slips.push({
          site_id: sites[i]._id, site_name: sites[i].name,
          manager_id: mgr._id, manager_name: mgr.name,
          items: [{ material_name: mat.name, quantity_taken: qty, unit: mat.unit,
                    unit_cost: mat.unit_cost, line_total: line }],
          total_value: line, status, orgId: org._id,
          createdAt: day(d), updatedAt: day(Math.max(0, d - decidedIn)),
          decided_at: status === 'pending' ? null : day(Math.max(0, d - decidedIn)),
          decided_by: status === 'pending' ? null : sa._id,
        });

        // Restocking: roughly monthly the manager asks for more and the owner
        // accepts. That is how stock went up over the year.
        if (d % 30 === 0 && mat.unit_cost !== null) {
          const oq = round(qty * rnd(6, 14), mat.unit === 'tonnes' ? 2 : 0);
          orders.push({
            material_name: mat.name, quantity: oq, unit: mat.unit,
            site_id: sites[i]._id, site_name: sites[i].name,
            status: 'accepted', requested_by: mgr.name, requested_by_id: mgr._id,
            reason: 'Stock running low for the current phase',
            unit_cost: mat.unit_cost, estimated_total: round(oq * mat.unit_cost),
            decided_by: sa._id, decided_at: day(Math.max(0, d - 1)), decision_note: 'Approved — reorder placed',
            orgId: org._id, createdAt: day(d), updatedAt: day(Math.max(0, d - 1)),
          });
        }
      }
    }

    // A live queue of undecided work, so the dashboard opens with something to do.
    for (let i = 0; i < 6; i++) {
      const si = i % 6;
      const mats = invDocs.filter((d) => d.site_name === sites[si].name && d.unit_cost !== null);
      const mat = pick(mats);
      const oq = round(rnd(20, 200), 0);
      orders.push({
        material_name: mat.name, quantity: oq, unit: mat.unit,
        site_id: sites[si]._id, site_name: sites[si].name, status: 'pending',
        requested_by: managers[si].name, requested_by_id: managers[si]._id,
        reason: 'Required for next week', unit_cost: mat.unit_cost,
        estimated_total: round(oq * mat.unit_cost), orgId: org._id,
        createdAt: day(rnd(1, 9)), updatedAt: day(rnd(1, 9)),
      });
    }

    await Slip.insertMany(slips, { timestamps: false });
    await Order.insertMany(orders, { timestamps: false });

    console.log('');
    console.log(`  ✅ ${ORG_NAME}  (${org._id})`);
    console.log(`     super admin   ${EMAIL} / ${PASSWORD}`);
    console.log(`     owners        ${OWNERS.length}, none with web access`);
    console.log(`     sites         ${sites.length}`);
    console.log(`     managers      ${managers.length} approved + 1 pending`);
    console.log(`     materials     ${invDocs.length} rows`);
    console.log(`     slips         ${slips.length}  (${slips.filter(s=>s.status==='pending').length} awaiting you)`);
    console.log(`     orders        ${orders.length}  (${orders.filter(o=>o.status==='pending').length} awaiting you)`);
    console.log(`     history       ${DAYS_HISTORY} days`);
    console.log('');
  } finally {
    await mongoose.disconnect();
  }
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
