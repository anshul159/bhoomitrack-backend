const mongoose = require('mongoose');

const siteSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  location: { type: String, trim: true, default: '' },
  owner_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
}, { timestamps: true });

// ─── Site-name uniqueness within an organisation (PF-002) ──────────────────────
//
// 15 simultaneous creates with one name produced 12 sites, in 15 of 15 rounds. Same
// read-then-write race as PF-001, and worse in its consequences: Inventory, Slip,
// Order and User all reference a site by `site_name` string rather than by id, so two
// sites sharing a name are indistinguishable to every downstream query — and there is
// no rename that repairs it, because renaming orphans four collections (ENH-007).
//
// Scoped to the organisation, not global: two unrelated firms may each have a
// "Site A" and that is none of our business.
siteSchema.index({ orgId: 1, name: 1 }, { unique: true, name: 'org_site_name_unique' });

module.exports = mongoose.model('Site', siteSchema);
