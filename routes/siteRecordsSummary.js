const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
// No `auth` here on purpose — applied at the mount in server.js (PF-007).
const { ownerOnly } = require('../middleware/roles');
const Site = require('../models/Site');
const SitePayment = require('../models/SitePayment');
const MaterialArrival = require('../models/MaterialArrival');
const { CFT_PER_BRASS } = require('../utils/volume');
const { ValidationError, periodFilter } = require('../utils/siteRecords');

// The owner's view across every site (v2): what was paid and what arrived, in
// total and site by site, for the owner home card and its breakdown.
//
// Its own path rather than /api/payments/summary, because that would shadow
// GET /api/payments/:site for a site that happens to be called "summary".

const round = (n, dp) => Number(n.toFixed(dp));

const emptySite = (id, name) => ({
  site_id: id,
  site_name: name,
  payments_amount: 0,
  payments_count: 0,
  arrivals_count: 0,
  arrivals_cft: 0,
  arrivals_m3: 0,
  arrivals_brass: 0,
  by_category: [],
  by_material: [],
});

// ─── GET /api/site-records/summary ────────────────────────────────────────────
// Owner only: it covers every site. Optional ?from=&to= bound payments by the
// day they were paid and arrivals by the day they arrived. Void entries are left
// out, as in every other total. Every site is listed, including ones where
// nothing was recorded, because a site that recorded nothing is itself
// something an owner wants to see.
router.get('/summary', ownerOnly, async (req, res) => {
  try {
    const orgId = new mongoose.Types.ObjectId(String(req.user.orgId));
    const payMatch = { orgId, status: 'recorded', ...periodFilter(req.query, 'paid_on') };
    const arrMatch = { orgId, status: 'recorded', ...periodFilter(req.query, 'received_on') };

    const [sites, payRows, arrRows] = await Promise.all([
      Site.find({ orgId }, '_id name').sort({ name: 1 }).lean(),
      SitePayment.aggregate([
        { $match: payMatch },
        {
          $group: {
            _id: { site: '$site_id', category: '$category' },
            site_name: { $last: '$site_name' },
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
      ]),
      MaterialArrival.aggregate([
        { $match: arrMatch },
        {
          $group: {
            _id: { site: '$site_id', material: '$material_name' },
            site_name: { $last: '$site_name' },
            cft: { $sum: '$volume_cft' },
            m3: { $sum: '$volume_m3' },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const bySite = new Map(sites.map((s) => [String(s._id), emptySite(s._id, s.name)]));
    const rowFor = (id, name) => {
      const key = String(id);
      if (!bySite.has(key)) bySite.set(key, emptySite(id, name));
      return bySite.get(key);
    };

    const orgCategories = new Map();
    for (const p of payRows) {
      const row = rowFor(p._id.site, p.site_name);
      row.payments_amount += p.total;
      row.payments_count += p.count;
      row.by_category.push({ category: p._id.category, total: round(p.total, 2), count: p.count });
      const org = orgCategories.get(p._id.category) || { category: p._id.category, total: 0, count: 0 };
      org.total += p.total;
      org.count += p.count;
      orgCategories.set(p._id.category, org);
    }

    // Material names are free text, so "Sand" at one site and "sand" at another
    // are one material in the company total. $group returns rows in no particular
    // order, so they are sorted first: by code unit, capitals come first, and the
    // capitalised spelling is the one shown — the same one every time.
    arrRows.sort((x, y) => (x._id.material < y._id.material ? -1 : x._id.material > y._id.material ? 1 : 0));
    const orgMaterials = new Map();
    for (const a of arrRows) {
      const row = rowFor(a._id.site, a.site_name);
      row.arrivals_count += a.count;
      row.arrivals_cft += a.cft;
      row.arrivals_m3 += a.m3;
      row.by_material.push({
        material_name: a._id.material,
        volume_cft: round(a.cft, 2),
        volume_m3: round(a.m3, 3),
        volume_brass: round(a.cft / CFT_PER_BRASS, 3),
        count: a.count,
      });
      const key = a._id.material.toLowerCase();
      const org = orgMaterials.get(key) || { material_name: a._id.material, cft: 0, m3: 0, count: 0 };
      org.cft += a.cft;
      org.m3 += a.m3;
      org.count += a.count;
      orgMaterials.set(key, org);
    }

    const siteRows = [...bySite.values()].map((s) => ({
      ...s,
      payments_amount: round(s.payments_amount, 2),
      arrivals_cft: round(s.arrivals_cft, 2),
      arrivals_m3: round(s.arrivals_m3, 3),
      arrivals_brass: round(s.arrivals_cft / CFT_PER_BRASS, 3),
      by_category: s.by_category.sort((x, y) => y.total - x.total),
      by_material: s.by_material.sort((x, y) => y.volume_cft - x.volume_cft),
    }));
    // Most money first, then most deliveries, then by name — so the sites that
    // need a look are at the top and the quiet ones collect at the bottom.
    siteRows.sort((x, y) =>
      (y.payments_amount - x.payments_amount) ||
      (y.arrivals_count - x.arrivals_count) ||
      x.site_name.localeCompare(y.site_name)
    );

    const totalCft = siteRows.reduce((sum, s) => sum + s.arrivals_cft, 0);
    const totals = {
      payments_amount: round(siteRows.reduce((sum, s) => sum + s.payments_amount, 0), 2),
      payments_count: siteRows.reduce((sum, s) => sum + s.payments_count, 0),
      arrivals_count: siteRows.reduce((sum, s) => sum + s.arrivals_count, 0),
      arrivals_cft: round(totalCft, 2),
      arrivals_m3: round(siteRows.reduce((sum, s) => sum + s.arrivals_m3, 0), 3),
      arrivals_brass: round(totalCft / CFT_PER_BRASS, 3),
      site_count: sites.length,
      active_site_count: siteRows.filter((s) => s.payments_count > 0 || s.arrivals_count > 0).length,
    };

    return res.json({
      success: true,
      message: 'OK',
      data: {
        totals,
        by_category: [...orgCategories.values()]
          .map((c) => ({ ...c, total: round(c.total, 2) }))
          .sort((x, y) => y.total - x.total),
        by_material: [...orgMaterials.values()]
          .map((m) => ({
            material_name: m.material_name,
            volume_cft: round(m.cft, 2),
            volume_m3: round(m.m3, 3),
            volume_brass: round(m.cft / CFT_PER_BRASS, 3),
            count: m.count,
          }))
          .sort((x, y) => y.volume_cft - x.volume_cft),
        sites: siteRows,
      },
    });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ success: false, message: err.message });
    console.error('[SITE RECORDS SUMMARY]', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
