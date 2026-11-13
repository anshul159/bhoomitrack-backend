const mongoose = require('mongoose');

// Loose material that arrived at a site measured by the vehicle load (v2) — sand,
// gitti, and the like. The volume is length x breadth x height of the load in
// the vehicle body, computed by the server.
//
// A record only: it does not change stock (decided 2026-11-10). It keeps the
// dimensions as well as the volume so that, once materials carry a density,
// weight can be computed for every past arrival without re-measuring anything.
const VEHICLE_TYPES = ['tractor_trolley', 'tipper', 'truck', 'mini_truck', 'other'];

const materialArrivalSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  site_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true },
  site_name: { type: String, required: true },

  material_name: { type: String, required: true, trim: true },
  // Set when the name matches a material the site already stocks — the link a
  // future "add arrivals to stock" step will need.
  inventory_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', default: null },

  vehicle_type: { type: String, enum: VEHICLE_TYPES, required: true },
  vehicle_number: { type: String, required: true },
  driver_name: { type: String, default: '' },
  supplier_name: { type: String, default: '' },

  length: { type: Number, required: true },
  breadth: { type: Number, required: true },
  height: { type: Number, required: true },
  dimension_unit: { type: String, enum: ['ft', 'm'], required: true },
  volume_cft: { type: Number, required: true },
  volume_m3: { type: Number, required: true },

  received_on: { type: Date, required: true },
  note: { type: String, default: '' },

  recorded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recorded_by_name: { type: String, default: '' },
  recorded_by_role: { type: String, default: '' },

  status: { type: String, enum: ['recorded', 'void'], default: 'recorded' },
  void_reason: { type: String, default: '' },
  voided_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  voided_at: { type: Date, default: null },

  client_request_id: { type: String, default: null },
}, { timestamps: true });

materialArrivalSchema.index({ orgId: 1, site_id: 1, received_on: -1 });
// Org-wide summaries filter on status across every site (see SitePayment).
materialArrivalSchema.index({ orgId: 1, status: 1, received_on: -1 });
materialArrivalSchema.index(
  { orgId: 1, client_request_id: 1 },
  { unique: true, name: 'arrival_client_request_unique', partialFilterExpression: { client_request_id: { $type: 'string' } } }
);

module.exports = mongoose.model('MaterialArrival', materialArrivalSchema);
module.exports.VEHICLE_TYPES = VEHICLE_TYPES;
