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

module.exports = mongoose.model('AuditLog', auditLogSchema);
