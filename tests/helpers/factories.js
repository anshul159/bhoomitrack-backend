// Fixture builders. Each returns the created documents plus a ready-to-use auth
// token, so a test can state what it needs in a line or two.

const bcrypt = require('bcryptjs');
const Organization = require('../../models/Organization');
const User = require('../../models/User');
const Site = require('../../models/Site');
const Inventory = require('../../models/Inventory');
const { makeToken } = require('../../utils/token');

const PASSWORD = 'Str0ngPassw0rd!';

async function createOrg(overrides = {}) {
  return Organization.create({ name: 'Test Construction Co', status: 'active', plan: 'standard', ...overrides });
}

async function createOwner(org, overrides = {}) {
  const user = await User.create({
    name: 'Test Owner',
    email: `owner-${Math.random().toString(36).slice(2, 8)}@example.com`,
    password: await bcrypt.hash(PASSWORD, 4),
    role: 'owner',
    status: 'approved',
    orgId: org._id,
    ...overrides,
  });
  return { user, token: makeToken(user) };
}

async function createManager(org, site, overrides = {}) {
  const user = await User.create({
    name: 'Test Manager',
    phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
    password: await bcrypt.hash(PASSWORD, 4),
    role: 'manager',
    status: 'approved',
    orgId: org._id,
    site_ids: site ? [site._id] : [],
    site_name: site ? site.name : '',
    ...overrides,
  });
  return { user, token: makeToken(user) };
}

async function createSite(org, name = 'Site A', overrides = {}) {
  return Site.create({ name, location: 'Testville', orgId: org._id, ...overrides });
}

async function createInventory(org, site, overrides = {}) {
  return Inventory.create({
    name: 'Cement',
    quantity: 100,
    unit: 'bags',
    site_id: site._id,
    site_name: site.name,
    low_stock_threshold: 50,
    orgId: org._id,
    ...overrides,
  });
}

/** A complete organisation: org, owner, site, manager, one material. */
async function createWorld(orgOverrides = {}) {
  const org = await createOrg(orgOverrides);
  const owner = await createOwner(org);
  const site = await createSite(org);
  const manager = await createManager(org, site);
  const item = await createInventory(org, site);
  return { org, owner, site, manager, item };
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

module.exports = {
  PASSWORD, createOrg, createOwner, createManager, createSite, createInventory,
  createWorld, bearer,
};
