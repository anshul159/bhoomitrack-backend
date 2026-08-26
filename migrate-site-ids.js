#!/usr/bin/env node
/**
 * One-time backfill for the schema changes introduced alongside ENH-007, ENH-013
 * and ENH-014.
 *
 *   1. Inventory / Slip / Order      site_name  →  site_id
 *   2. User.site_name                           →  site_ids[]
 *   3. User.fcmToken (single string)            →  fcmTokens[]
 *   4. Legacy plaintext User.otp                →  cleared
 *   5. Organization                             →  given a plan/status if absent
 *
 * Safe to run more than once: every step skips rows that already carry the new
 * shape, and nothing is deleted except the legacy plaintext reset code, which is
 * worthless to keep.
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://..." node migrate-site-ids.js [--dry-run]
 *
 * Run it with --dry-run first. It reports exactly what it would change.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Site = require('./models/Site');
const Inventory = require('./models/Inventory');
const Slip = require('./models/Slip');
const Order = require('./models/Order');
const User = require('./models/User');
const Organization = require('./models/Organization');

const DRY_RUN = process.argv.includes('--dry-run');

if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI is required. Refusing to guess a connection string.');
  process.exit(1);
}

const log = (...args) => console.log(...args);

async function backfillCollection(Model, label, siteIndex) {
  const pending = await Model.find({ site_id: { $in: [null, undefined] } }, 'site_name orgId').lean();
  if (pending.length === 0) {
    log(`  ${label}: nothing to do`);
    return { matched: 0, unmatched: 0 };
  }

  const ops = [];
  let unmatched = 0;
  const unmatchedNames = new Set();

  for (const doc of pending) {
    const key = `${doc.orgId}||${doc.site_name}`;
    const siteId = siteIndex.get(key);
    if (!siteId) {
      unmatched += 1;
      unmatchedNames.add(doc.site_name);
      continue;
    }
    ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { site_id: siteId } } } });
  }

  if (ops.length > 0 && !DRY_RUN) await Model.bulkWrite(ops);

  log(`  ${label}: ${ops.length} to backfill, ${unmatched} unmatched`);
  if (unmatchedNames.size > 0) {
    log(`     ⚠️  no Site row for: ${[...unmatchedNames].join(', ')}`);
    log('        These keep working through the site_name fallback, but create the');
    log('        missing sites and re-run to put them on ids.');
  }
  return { matched: ops.length, unmatched };
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  log(`✅ Connected${DRY_RUN ? ' (DRY RUN — nothing will be written)' : ''}\n`);

  // ── Index every site by org + name ────────────────────────────────────────
  const sites = await Site.find({}, 'name orgId').lean();
  const siteIndex = new Map(sites.map(s => [`${s.orgId}||${s.name}`, s._id]));
  log(`Found ${sites.length} sites across ${new Set(sites.map(s => String(s.orgId))).size} organisations\n`);

  // ── 1. Data collections ───────────────────────────────────────────────────
  log('1. Backfilling site_id:');
  await backfillCollection(Inventory, 'Inventory', siteIndex);
  await backfillCollection(Slip, 'Slip', siteIndex);
  await backfillCollection(Order, 'Order', siteIndex);

  // ── 2. Manager assignments ────────────────────────────────────────────────
  log('\n2. Backfilling User.site_ids:');
  const managers = await User.find({
    role: 'manager',
    site_name: { $nin: ['', null] },
    $or: [{ site_ids: { $exists: false } }, { site_ids: { $size: 0 } }],
  }, 'site_name orgId').lean();

  let assigned = 0;
  const assignOps = [];
  for (const m of managers) {
    const siteId = siteIndex.get(`${m.orgId}||${m.site_name}`);
    if (!siteId) continue;
    assignOps.push({ updateOne: { filter: { _id: m._id }, update: { $set: { site_ids: [siteId] } } } });
    assigned += 1;
  }
  if (assignOps.length > 0 && !DRY_RUN) await User.bulkWrite(assignOps);
  log(`  ${assigned} of ${managers.length} manager assignments mapped to a site id`);

  // ── 3. Push tokens ────────────────────────────────────────────────────────
  log('\n3. Migrating fcmToken → fcmTokens[]:');
  const withLegacyToken = await User.find({
    fcmToken: { $nin: ['', null] },
    $or: [{ fcmTokens: { $exists: false } }, { fcmTokens: { $size: 0 } }],
  }, 'fcmToken').lean();

  if (withLegacyToken.length > 0 && !DRY_RUN) {
    await User.bulkWrite(withLegacyToken.map(u => ({
      updateOne: {
        filter: { _id: u._id },
        update: {
          $set: { fcmTokens: [{ token: u.fcmToken, platform: 'android', lastSeenAt: new Date() }] },
          $unset: { fcmToken: '' },
        },
      },
    })));
  }
  log(`  ${withLegacyToken.length} device tokens carried over`);

  // ── 4. Legacy plaintext reset codes ───────────────────────────────────────
  // These were stored unhashed. Any outstanding one is cleared rather than
  // converted: a reset code is short-lived, and asking for a new one costs the
  // user one tap.
  log('\n4. Clearing legacy plaintext reset codes:');
  const legacyOtp = await User.countDocuments({ otp: { $ne: null } });
  if (legacyOtp > 0 && !DRY_RUN) {
    await User.updateMany({ otp: { $ne: null } }, { $unset: { otp: '', otpExpiry: '' } });
  }
  log(`  ${legacyOtp} cleared`);

  // ── 5. Organisation subscription defaults ─────────────────────────────────
  // Existing customers predate billing, so they are marked active rather than
  // dropped into a trial that would expire under them.
  log('\n5. Setting organisation subscription defaults:');
  const orgsNeedingStatus = await Organization.countDocuments({ status: { $exists: false } });
  if (orgsNeedingStatus > 0 && !DRY_RUN) {
    await Organization.updateMany(
      { status: { $exists: false } },
      { $set: { plan: 'standard', status: 'active', currentPeriodEnd: null, currency: 'INR' } }
    );
  }
  log(`  ${orgsNeedingStatus} organisations marked active (existing customers predate billing)`);

  log(`\n${DRY_RUN ? '🔍 Dry run complete — nothing was written.' : '✅ Migration complete.'}`);
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error('❌ Migration failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
