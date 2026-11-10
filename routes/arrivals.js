const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
// No `auth` here on purpose — applied at the mount in server.js (PF-007).
const { ownerOnly, requireApproved } = require('../middleware/roles');
const siteAccess = require('../middleware/siteAccess');
const MaterialArrival = require('../models/MaterialArrival');
const Inventory = require('../models/Inventory');
const { parsePaging, paginate } = require('../utils/pagination');
const { computeVolume, CFT_PER_BRASS } = require('../utils/volume');
const audit = require('../utils/audit');
const {
  ValidationError, writableSite, optionalText, requiredText, vehicleNumber,
  eventDate, clientRequestId, createOnce, periodFilter, voidHandler,
} = require('../utils/siteRecords');

// Material arrivals measured by volume (v2) — sand, gitti and other loose
// material that comes by the vehicle-load. A record only; stock is unchanged.

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const arrivalToResponse = (a) => ({
  id: a._id,
  site_id: a.site_id,
  site_name: a.site_name,
  material_name: a.material_name,
  inventory_id: a.inventory_id || null,
  vehicle_type: a.vehicle_type,
  vehicle_number: a.vehicle_number,
  driver_name: a.driver_name || '',
  supplier_name: a.supplier_name || '',
  length: a.length,
  breadth: a.breadth,
  height: a.height,
  dimension_unit: a.dimension_unit,
  volume_cft: a.volume_cft,
  volume_m3: a.volume_m3,
  volume_brass: Number((a.volume_cft / CFT_PER_BRASS).toFixed(3)),
  received_on: a.received_on,
  note: a.note || '',
  recorded_by_name: a.recorded_by_name || '',
  recorded_by_role: a.recorded_by_role || '',
  status: a.status,
  void_reason: a.void_reason || '',
  voided_at: a.voided_at || null,
  created_at: a.createdAt,
});

// ─── POST /api/arrivals ───────────────────────────────────────────────────────
router.post('/', requireApproved, async (req, res) => {
  try {
    const body = req.body || {};
    const requestId = clientRequestId(req);

    const where = await writableSite(req, body.site_name);
    if (where.status) return res.status(where.status).json({ success: false, message: where.message });
    const { site } = where;

    const materialName = requiredText(body.material_name, 100, 'Material');
    if (!MaterialArrival.VEHICLE_TYPES.includes(body.vehicle_type)) {
      throw new ValidationError('Choose the vehicle type');
    }
    const unit = body.dimension_unit || 'ft';
    const volume = computeVolume(body.length, body.breadth, body.height, unit);
    if (volume.error) throw new ValidationError(volume.error);

    // Link to the site's stock row for the same material when there is one, so a
    // later "add to stock" step has nothing to guess.
    const stock = await Inventory.findOne({
      orgId: req.user.orgId,
      site_id: site._id,
      name: new RegExp(`^${escapeRegex(materialName)}$`, 'i'),
    }, '_id name').lean();

    const doc = {
      site_id: site._id,
      site_name: site.name,
      // The stock row's own spelling, so "sand" and "Sand" are one material.
      material_name: stock ? stock.name : materialName,
      inventory_id: stock ? stock._id : null,
      vehicle_type: body.vehicle_type,
      vehicle_number: vehicleNumber(body.vehicle_number, { required: true }),
      driver_name: optionalText(body.driver_name, 100, 'Driver name'),
      supplier_name: optionalText(body.supplier_name, 100, 'Supplier name'),
      length: Number(body.length),
      breadth: Number(body.breadth),
      height: Number(body.height),
      dimension_unit: unit,
      volume_cft: volume.volume_cft,
      volume_m3: volume.volume_m3,
      received_on: eventDate(body.received_on, 'Arrival date'),
      note: optionalText(body.note, 500, 'Note'),
      recorded_by: req.user.id,
      recorded_by_name: req.user.name || '',
      recorded_by_role: req.user.role,
    };

    const { record, replay } = await createOnce(MaterialArrival, req.user.orgId, requestId, doc);

    if (!replay) {
      audit.record(req, {
        action: 'arrival.record',
        entity: 'arrival',
        entity_id: record._id,
        entity_label: `${record.material_name} · ${record.vehicle_number}`,
        site_id: site._id,
        site_name: site.name,
        after: { volume_cft: record.volume_cft, vehicle_type: record.vehicle_type },
      });
    }

    return res.json({
      success: true,
      message: 'Material arrival recorded',
      data: arrivalToResponse(record),
      ...(replay ? { idempotent_replay: true } : {}),
    });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ success: false, message: err.message });
    console.error('[ARRIVAL RECORD]', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/arrivals/:site ──────────────────────────────────────────────────
// Newest first, void entries included. `summary` totals recorded arrivals per
// material. Optional ?from=&to= bound both by arrival date.
router.get('/:site', siteAccess, async (req, res) => {
  try {
    const filter = { orgId: req.user.orgId, site_id: req.site._id, ...periodFilter(req.query, 'received_on') };
    const paging = parsePaging(req.query, { defaultLimit: 100 });

    const [result, byMaterial] = await Promise.all([
      paginate(MaterialArrival, filter, paging, { received_on: -1 }, arrivalToResponse),
      MaterialArrival.aggregate([
        { $match: { ...filter, orgId: new mongoose.Types.ObjectId(String(req.user.orgId)), status: 'recorded' } },
        { $group: { _id: '$material_name', cft: { $sum: '$volume_cft' }, m3: { $sum: '$volume_m3' }, count: { $sum: 1 } } },
        { $sort: { cft: -1 } },
      ]),
    ]);

    const summary = {
      count: byMaterial.reduce((sum, m) => sum + m.count, 0),
      by_material: byMaterial.map((m) => ({
        material_name: m._id,
        volume_cft: Number(m.cft.toFixed(2)),
        volume_m3: Number(m.m3.toFixed(3)),
        volume_brass: Number((m.cft / CFT_PER_BRASS).toFixed(3)),
        count: m.count,
      })),
    };

    return res.json({ success: true, message: 'OK', ...result, summary });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ success: false, message: err.message });
    console.error('[ARRIVAL LIST]', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/arrivals/void/:id ───────────────────────────────────────────────
router.put('/void/:id', ownerOnly, voidHandler(MaterialArrival, {
  entity: 'arrival',
  label: (a) => `${a.material_name} · ${a.vehicle_number}`,
  format: arrivalToResponse,
}));

module.exports = router;
