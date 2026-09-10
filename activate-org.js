#!/usr/bin/env node
/**
 * Put one organisation on permanent, never-expiring access — by the email of any
 * of its members.
 *
 * Why this exists separately from admin-billing.js: that tool writes the full
 * billing record (plan, cycle, payment history), and those fields only exist on
 * `feature/billing`. PRODUCTION IS RUNNING main, whose Organization model accepts
 * plan values ['trial','standard'] ONLY. Writing plan:'founding' there would read
 * back fine — Mongoose does not validate on read — but the next org.save() would
 * throw a ValidationError, and PUT /api/org/settings would start returning 500s
 * for a reason nobody would find quickly.
 *
 * So this touches ONLY fields the deployed code already understands:
 *
 *   status:           'active'
 *   currentPeriodEnd:  null      → isActive() returns true forever
 *
 * That is genuinely the maximum. Nothing in the codebase gates on `plan` — it
 * appears in two API responses and the pricing calculator and nowhere else — and
 * there is no site cap, because billing was built to bill an extra site rather
 * than block it. Access is decided entirely by isActive().
 *
 * Once feature/billing is merged and deployed, record the real thing instead:
 *   node admin-billing.js mark-paid <org> --amount=100000 --lifetime --yes
 *
 * Usage:
 *   node activate-org.js <email>            # shows what it would do
 *   node activate-org.js <email> --yes      # applies it
 *
 * MONGODB_URI is read from the environment or .env. It is never printed.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const email = (process.argv[2] || '').toLowerCase().trim();
const APPLY = process.argv.includes('--yes');

if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI is not set. Put it in .env (gitignored) or the environment.');
  process.exit(1);
}
if (!email || email.startsWith('--')) {
  console.error('Usage: node activate-org.js <email> [--yes]');
  process.exit(1);
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('./models/User');
  const Organization = require('./models/Organization');
  const Site = require('./models/Site');

  try {
    const user = await User.findOne({ email, deletedAt: null }).select('name email role orgId');
    if (!user) {
      const near = await User.find({ email: new RegExp(email.split('@')[0], 'i'), deletedAt: null })
        .select('email role').limit(5).lean();
      console.error(`❌ No live account for "${email}".`);
      if (near.length) {
        console.error('   Did you mean:');
        for (const n of near) console.error(`     ${n.email}  (${n.role})`);
      }
      process.exitCode = 1;
      return;
    }

    const org = await Organization.findById(user.orgId);
    if (!org) { console.error('❌ That account has no organisation.'); process.exitCode = 1; return; }
    const sites = await Site.countDocuments({ orgId: org._id });

    const before = {
      status: org.status,
      currentPeriodEnd: org.currentPeriodEnd ? org.currentPeriodEnd.toISOString().slice(0, 10) : null,
      active: org.isActive(),
    };

    console.log('');
    console.log(`  ${user.name} <${user.email}>  (${user.role})`);
    console.log(`  ${org.name}  ·  ${sites} site${sites === 1 ? '' : 's'}`);
    console.log('');
    console.log(`    status             ${before.status}  →  active`);
    console.log(`    currentPeriodEnd   ${before.currentPeriodEnd || '—'}  →  never (permanent)`);
    console.log(`    plan               ${org.plan}  →  unchanged (see the note in this file)`);
    console.log('');

    if (!APPLY) {
      console.log('  Nothing changed. Re-run with --yes to apply.');
      console.log('');
      return;
    }

    // updateOne, not save(): a full document save would revalidate every field,
    // and this deployment's enum is narrower than the branch that wrote this file.
    await Organization.updateOne({ _id: org._id }, {
      $set: { status: 'active', currentPeriodEnd: null, suspendedAt: null, suspensionReason: '' },
    });

    const after = await Organization.findById(org._id);
    console.log(`  ✅ ${org.name} is active and will not expire.`);
    console.log(`     Verified: status=${after.status}, isActive()=${after.isActive()}`);
    // requireActiveOrg loads the organisation on every request, so this is live
    // on their very next call — no re-login, on any device.
    console.log('     Effective immediately on their next request, on every device.');
    console.log('');
  } finally {
    await mongoose.disconnect();
  }
})().catch((err) => { console.error('❌', err.message); process.exit(1); });
