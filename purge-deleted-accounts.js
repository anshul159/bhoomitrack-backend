#!/usr/bin/env node
/**
 * Removes user rows whose retention window has passed (ENH-013).
 *
 * Deleting an account sets `deletedAt` and `purgeAfter`; the account stops
 * working immediately. This job does the irreversible part, once the window has
 * elapsed, so an accidental deletion can be reversed in the meantime.
 *
 * What is deliberately NOT deleted: the slips the person raised and the audit
 * rows naming them. Those are another party's records — the organisation's — and
 * shredding a site's history because one manager left would destroy exactly what
 * the product exists to preserve. Their name is scrubbed to a tombstone instead.
 *
 * Run daily. On Render this is a Cron Job:
 *   node purge-deleted-accounts.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

const DRY_RUN = process.argv.includes('--dry-run');

if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI is required.');
  process.exit(1);
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const now = new Date();
  const due = await User.find({
    deletedAt: { $ne: null },
    purgeAfter: { $ne: null, $lte: now },
  }, 'name email phone orgId').lean();

  console.log(`${due.length} account(s) past their retention window${DRY_RUN ? ' (dry run)' : ''}`);

  for (const u of due) {
    console.log(`  purging ${u._id} (${u.name})`);
    if (DRY_RUN) continue;

    // Tombstone rather than delete: slips and audit rows reference this id, and a
    // dangling reference reads as data corruption to anyone auditing later.
    await User.updateOne({ _id: u._id }, {
      $set: {
        name: 'Deleted user',
        email: '',
        phone: '',
        password: '',
        site_ids: [],
        site_name: '',
        fcmTokens: [],
        purgeAfter: null,
      },
      $unset: { otpHash: '', otpExpiry: '', fcmToken: '' },
    });
  }

  console.log(DRY_RUN ? '🔍 Dry run complete.' : '✅ Purge complete.');
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error('❌ Purge failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
