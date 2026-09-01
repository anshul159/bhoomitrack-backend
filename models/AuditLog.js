const mongoose = require('mongoose');

// Append-only record of who changed what (ENH-008).
//
// The product is a system of record for materials worth real money; its value in
// a dispute depends on being able to show the previous value and who set it.
// Nothing in the API updates or deletes these rows.
const auditLogSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },

  actor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  actor_name: { type: String, default: '' },
  actor_role: { type: String, default: '' },

  // e.g. 'inventory.update', 'slip.approve', 'user.assign_site', 'org.suspend'
  action: { type: String, required: true, index: true },
  entity: { type: String, required: true },              // 'inventory' | 'slip' | 'user' | 'site' | 'order' | 'organization'
  entity_id: { type: mongoose.Schema.Types.ObjectId, default: null },
  entity_label: { type: String, default: '' },           // human-readable, e.g. the material name

  site_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', default: null },
  site_name: { type: String, default: '' },

  // Only the fields that actually changed, not whole documents.
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  after: { type: mongoose.Schema.Types.Mixed, default: null },
  note: { type: String, default: '' },
}, { timestamps: { createdAt: true, updatedAt: false } });

auditLogSchema.index({ orgId: 1, createdAt: -1 });
auditLogSchema.index({ orgId: 1, entity: 1, entity_id: 1, createdAt: -1 });

// Retention (PF-010).
//
// One slip lifecycle writes two audit rows against one slip row, and every inventory
// edit, order decision and site change adds more — so this collection grows at roughly
// twice the rate of the business data it describes, and had no bound of any kind. Left
// alone it becomes the largest collection in the database.
//
// A TTL index is the fix rather than a cron job: MongoDB expires the rows itself, so
// there is no script to schedule, forget, or have fail silently.
//
// The default is deliberately long. These rows are what the product shows in a dispute
// about material worth real money, so the retention window has to outlast the argument,
// not merely the storage bill. Set AUDIT_RETENTION_DAYS=0 to disable expiry entirely —
// which is the right setting if a customer's contract or a regulator requires it.
const AUDIT_RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS ?? 1095); // 3 years

if (AUDIT_RETENTION_DAYS > 0) {
  auditLogSchema.index(
    { createdAt: 1 },
    { expireAfterSeconds: AUDIT_RETENTION_DAYS * 24 * 60 * 60, name: 'audit_ttl' }
  );
}

module.exports = mongoose.model('AuditLog', auditLogSchema);
module.exports.RETENTION_DAYS = AUDIT_RETENTION_DAYS;
