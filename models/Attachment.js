const mongoose = require('mongoose');

// A file attached to a site record — today, the photo of a bill or challan (v2).
//
// Stored as binary in its own collection because there is no object store yet.
// Keeping it out of the record it belongs to means a list of payments never
// carries images, and moving to object storage later is a change to this one
// collection: the records only hold an id.
const attachmentSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  // Kept so a manager can be refused a bill from a site they are not assigned to.
  site_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true },

  kind: { type: String, enum: ['bill'], default: 'bill' },
  content_type: { type: String, required: true },
  size: { type: Number, required: true },
  // Never returned by a query unless asked for, so metadata reads stay small.
  data: { type: Buffer, required: true, select: false },

  uploaded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

attachmentSchema.index({ orgId: 1, _id: 1 });

module.exports = mongoose.model('Attachment', attachmentSchema);
