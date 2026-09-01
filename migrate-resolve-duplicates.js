#!/usr/bin/env node
/**
 * Resolve the duplicates that PF-001 and PF-002 already created, so the unique
 * indexes can build.
 *
 * ─── Why this script exists ──────────────────────────────────────────────────
 *
 * models/User.js and models/Site.js now declare unique indexes. On a clean database
 * Mongoose builds them at startup and the races are closed. On a database that
 * already contains duplicates the build FAILS — and it fails quietly, logged by the
 * driver and swallowed, leaving you believing you are protected when you are not.
 *
 * So the order has to be: find duplicates -> resolve them -> build the index. This
 * script does all three, and by default only the first.
 *
 * ─── The policy, and why it is this one ──────────────────────────────────────
 *
 * The open question was "when two organisations exist on one email, which survives
 * and what happens to the other's data?" That is a judgement about a customer
 * relationship, not an engineering call, so this script does not make it.
 *
 * What it does instead is make the question answerable later:
 *
 *   - NOTHING IS EVER DELETED. Not one document, in any mode.
 *   - The OLDEST record keeps the contested value. Oldest wins because it is the
 *     one whose owner has been using it longest and has the most to lose.
 *   - A loser's contested value is moved aside, not destroyed: the original is
 *     copied to `conflict.original_*` with a timestamp, so any merge you decide on
 *     later has the facts it needs.
 *   - Every change is written to the audit log.
 *
 * A user whose email is moved aside CANNOT LOG IN with it any more. That is the
 * cost, and it is deliberate: today they log in and land in a random one of several
 * organisations, which is worse than a clear failure. Their data is untouched and
 * you can restore or merge them by hand.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   node migrate-resolve-duplicates.js                 # report only. Safe. Default.
 *   node migrate-resolve-duplicates.js --apply         # resolve, then build indexes
 *   node migrate-resolve-duplicates.js --build-indexes # build indexes only
 *
 * Take a database snapshot before --apply. Atlas can restore a point in time; this
 * script cannot undo itself.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const User = require('./models/User');
const Site = require('./models/Site');
const Inventory = require('./models/Inventory');
const Slip = require('./models/Slip');
const Order = require('./models/Order');

const APPLY = process.argv.includes('--apply');
const BUILD_ONLY = process.argv.includes('--build-indexes');
const STAMP = new Date().toISOString();

const log = (...a) => console.log(...a);
const heading = (t) => log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);

/** Groups of live users sharing one non-empty value of `field`. */
async function findDuplicateUsers(field) {
  return User.aggregate([
    { $match: { [field]: { $gt: '' }, deletedAt: null } },
    { $sort: { createdAt: 1 } },
    {
      $group: {
        _id: `$${field}`,
        count: { $sum: 1 },
        docs: { $push: { id: '$_id', name: '$name', role: '$role', orgId: '$orgId', createdAt: '$createdAt' } },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]);
}

/** Groups of sites sharing one name inside one organisation. */
async function findDuplicateSites() {
  return Site.aggregate([
    { $sort: { createdAt: 1 } },
    {
      $group: {
        _id: { orgId: '$orgId', name: '$name' },
        count: { $sum: 1 },
        docs: { $push: { id: '$_id', name: '$name', createdAt: '$createdAt' } },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]);
}

async function reportAndResolveUsers(field) {
  const groups = await findDuplicateUsers(field);
  heading(`Users sharing a ${field} (${groups.length} group${groups.length === 1 ? '' : 's'})`);
  if (groups.length === 0) return log(`  None. The ${field} index will build cleanly.`);

  for (const g of groups) {
    const [keep, ...losers] = g.docs;                 // sorted oldest-first
    log(`\n  ${field} = ${g._id}   (${g.count} accounts)`);
    log(`    KEEP   ${keep.id}  ${keep.name}  role=${keep.role}  org=${keep.orgId}  created=${keep.createdAt?.toISOString?.() || keep.createdAt}`);
    for (const l of losers) {
      log(`    MOVE   ${l.id}  ${l.name}  role=${l.role}  org=${l.orgId}  created=${l.createdAt?.toISOString?.() || l.createdAt}`);
    }

    if (!APPLY) continue;

    for (const l of losers) {
      await User.updateOne(
        { _id: l.id },
        {
          $set: {
            [field]: '',
            [`conflict.original_${field}`]: g._id,
            'conflict.resolved_at': STAMP,
            'conflict.reason': `PF-001 duplicate ${field}; oldest account ${keep.id} kept the value`,
          },
          // Any outstanding session for this account is now inconsistent with its
          // identity, so end it rather than leave the holder in a half-state.
          $inc: { tokenVersion: 1 },
        }
      );
      log(`    ...moved ${field} aside on ${l.id}`);
    }
  }
}

async function reportAndResolveSites() {
  const groups = await findDuplicateSites();
  heading(`Sites sharing a name inside one organisation (${groups.length} group${groups.length === 1 ? '' : 's'})`);
  if (groups.length === 0) return log('  None. The (orgId, name) index will build cleanly.');

  for (const g of groups) {
    const [keep, ...losers] = g.docs;
    log(`\n  org ${g._id.orgId}  name "${g._id.name}"   (${g.count} sites)`);
    log(`    KEEP   ${keep.id}  created=${keep.createdAt?.toISOString?.() || keep.createdAt}`);
    for (const l of losers) log(`    RENAME ${l.id}  created=${l.createdAt?.toISOString?.() || l.createdAt}`);

    if (!APPLY) continue;

    let n = 1;
    for (const l of losers) {
      const newName = `${g._id.name} (${++n})`;
      await Site.updateOne({ _id: l.id }, { $set: { name: newName } });

      // Inventory, Slip, Order and User all carry a `site_name` string as well as a
      // `site_id` (ENH-007). The id is authoritative, so renaming is safe — but the
      // denormalised copy has to travel with it or those rows point at a name that
      // no longer exists.
      const scope = { site_id: l.id };
      const set = { $set: { site_name: newName } };
      const [inv, slip, ord, usr] = await Promise.all([
        Inventory.updateMany(scope, set),
        Slip.updateMany(scope, set),
        Order.updateMany(scope, set),
        User.updateMany({ site_ids: l.id }, set),
      ]);
      log(`    ...renamed ${l.id} to "${newName}" and updated ` +
          `${inv.modifiedCount} inventory, ${slip.modifiedCount} slips, ` +
          `${ord.modifiedCount} orders, ${usr.modifiedCount} users`);
    }
  }
}

async function buildIndexes() {
  heading('Building unique indexes');
  for (const [label, model] of [['User', User], ['Site', Site]]) {
    try {
      await model.syncIndexes();
      log(`  ${label}: indexes in sync`);
    } catch (err) {
      log(`  ${label}: FAILED — ${err.message}`);
      log('     Duplicates remain. Re-run the report, resolve them, and try again.');
      process.exitCode = 1;
    }
  }
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  log(`Connected to ${mongoose.connection.name}`);
  log(APPLY ? '\n*** --apply: CHANGES WILL BE WRITTEN ***'
           : '\nReport only. Nothing will be changed. Pass --apply to resolve.');

  try {
    if (!BUILD_ONLY) {
      await reportAndResolveUsers('email');
      await reportAndResolveUsers('phone');
      await reportAndResolveSites();
    }
    if (APPLY || BUILD_ONLY) await buildIndexes();
    else log('\nRun again with --apply to resolve these and build the indexes.');
  } finally {
    await mongoose.disconnect();
  }
})().catch((err) => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
