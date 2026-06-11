/**
 * One-time migration: assign all data that has no orgId to the original (oldest) org.
 * Run once on the production database BEFORE deploying the multi-tenancy backend.
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://..." node migrate-org-isolation.js
 */

const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI env var is required');
  process.exit(1);
}

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  // Find the oldest organization — that's the original company's org
  const Org = mongoose.model('Organization', new mongoose.Schema({}, { strict: false }));
  const orgs = await Org.find().sort({ createdAt: 1 }).limit(1).lean();
  if (orgs.length === 0) {
    console.error('No organizations found. Create a company first.');
    process.exit(1);
  }
  const originalOrgId = orgs[0]._id;
  console.log(`Using original org: ${orgs[0].name || orgs[0]._id} (${originalOrgId})`);

  // Migrate each collection: set orgId on all docs that currently have no orgId
  const collections = ['sites', 'inventories', 'slips', 'orders'];
  for (const col of collections) {
    const coll = mongoose.connection.collection(col);
    const result = await coll.updateMany(
      { orgId: { $exists: false } },
      { $set: { orgId: originalOrgId } }
    );
    console.log(`${col}: updated ${result.modifiedCount} documents`);
  }

  // Also assign managers with no orgId to the original org
  const result = await mongoose.connection.collection('users').updateMany(
    { role: 'manager', orgId: { $exists: false } },
    { $set: { orgId: originalOrgId } }
  );
  console.log(`users (managers): updated ${result.modifiedCount} documents`);

  console.log('Migration complete.');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
