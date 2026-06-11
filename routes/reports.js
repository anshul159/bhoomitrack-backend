const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { ownerOnly } = require('../middleware/roles');
const Slip = require('../models/Slip');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');

// ─── GET /api/reports/analytics ───────────────────────────────────────────────
// Owner only. Construction-inventory analytics computed server-side.
//
// Query params:
//   site  — optional site name; omit (or "All Sites") for every site
//   days  — lookback window: 1, 7, 30, 90, 365; 0 or omitted = inception to date
//
// Returns:
//   inventory_health    — in/low/out-of-stock counts for the scope
//   top_consumed        — most-consumed materials (approved slips only)
//   consumption_trend   — daily consumption totals for trend charting
//   stock_forecast      — per material: avg daily use + estimated days of stock left
//   site_comparison     — per-site activity & consumption (only when no site filter)
//   slip_stats          — slip counts, approval rate, avg approval turnaround
//   order_stats         — order counts + acceptance rate
//   by_manager          — slip activity per manager (accountability / reconciliation)
router.get('/analytics', auth, ownerOnly, async (req, res) => {
  try {
    const days = Math.max(0, parseInt(req.query.days, 10) || 0);
    const site = req.query.site && req.query.site !== 'All Sites' ? String(req.query.site) : null;
    const since = days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;

    const rangeMatch = since ? { createdAt: { $gte: since } } : {};
    const siteMatch = site ? { site_name: site } : {};
    const slipMatchAll = { ...rangeMatch, ...siteMatch };                       // slips, any status
    const slipMatchApproved = { ...slipMatchAll, status: 'approved' };          // consumption = approved only

    const [
      inventory,
      topConsumed,
      trend,
      consumptionByItem,
      slipStatusAgg,
      orderStatusAgg,
      byManager,
      siteCmpSlips,
      siteCmpInv,
      oldestSlip,
    ] = await Promise.all([

      // Inventory for the scope (health + forecast)
      Inventory.find(siteMatch).lean(),

      // 1. Top consumed materials
      Slip.aggregate([
        { $match: slipMatchApproved },
        { $unwind: '$items' },
        {
          $group: {
            _id: { name: '$items.material_name', unit: '$items.unit' },
            total_taken: { $sum: '$items.quantity_taken' },
            slip_count: { $sum: 1 },
          }
        },
        { $sort: { total_taken: -1 } },
        { $limit: 10 },
        { $project: { _id: 0, material_name: '$_id.name', unit: '$_id.unit', total_taken: 1, slip_count: 1 } },
      ]),

      // 2. Daily consumption trend
      Slip.aggregate([
        { $match: slipMatchApproved },
        { $unwind: '$items' },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            total: { $sum: '$items.quantity_taken' },
            slips: { $addToSet: '$_id' },
          }
        },
        { $project: { _id: 0, date: '$_id', total_quantity: '$total', slip_count: { $size: '$slips' } } },
        { $sort: { date: 1 } },
        { $limit: 366 },
      ]),

      // 3. Consumption per site+material (drives stock runway forecast)
      Slip.aggregate([
        { $match: slipMatchApproved },
        { $unwind: '$items' },
        {
          $group: {
            _id: { site: '$site_name', name: '$items.material_name' },
            total: { $sum: '$items.quantity_taken' },
          }
        },
      ]),

      // 4. Slip stats by status (incl. avg approval turnaround)
      Slip.aggregate([
        { $match: slipMatchAll },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            avg_hours: { $avg: { $divide: [{ $subtract: ['$updatedAt', '$createdAt'] }, 3600000] } },
          }
        },
      ]),

      // 5. Order stats by status
      Order.aggregate([
        { $match: slipMatchAll },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),

      // 6. Activity per manager (helps owners reconcile who is drawing materials)
      Slip.aggregate([
        { $match: slipMatchAll },
        {
          $group: {
            _id: '$manager_name',
            slips: { $sum: 1 },
            approved: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
            rejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
            quantity_taken: { $sum: { $sum: '$items.quantity_taken' } },
          }
        },
        { $sort: { slips: -1 } },
        { $limit: 8 },
        { $project: { _id: 0, manager_name: '$_id', slips: 1, approved: 1, rejected: 1, quantity_taken: 1 } },
      ]),

      // 7a. Site comparison — slip activity per site (all sites, range only)
      site ? Promise.resolve([]) : Slip.aggregate([
        { $match: rangeMatch },
        {
          $group: {
            _id: '$site_name',
            slips: { $sum: 1 },
            approved: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
            pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
            quantity_consumed: {
              $sum: { $cond: [{ $eq: ['$status', 'approved'] }, { $sum: '$items.quantity_taken' }, 0] }
            },
          }
        },
        { $sort: { quantity_consumed: -1 } },
      ]),

      // 7b. Site comparison — low stock per site
      site ? Promise.resolve([]) : Inventory.aggregate([
        {
          $group: {
            _id: '$site_name',
            total_materials: { $sum: 1 },
            low_stock: { $sum: { $cond: [{ $lt: ['$quantity', '$low_stock_threshold'] }, 1, 0] } },
            out_of_stock: { $sum: { $cond: [{ $lte: ['$quantity', 0] }, 1, 0] } },
          }
        },
      ]),

      // 8. Oldest slip in scope — to compute the real period length for averages
      Slip.findOne(slipMatchApproved).sort({ createdAt: 1 }).select('createdAt').lean(),
    ]);

    // ── Inventory health ────────────────────────────────────────────────────
    const inStock = inventory.filter(i => i.quantity >= i.low_stock_threshold).length;
    const lowStock = inventory.filter(i => i.quantity > 0 && i.quantity < i.low_stock_threshold).length;
    const outOfStock = inventory.filter(i => i.quantity <= 0).length;

    // ── Stock runway forecast ───────────────────────────────────────────────
    // period over which consumption was observed (for daily averages)
    let periodDays;
    if (days > 0) periodDays = days;
    else if (oldestSlip) periodDays = Math.max(1, Math.ceil((Date.now() - new Date(oldestSlip.createdAt).getTime()) / 86400000));
    else periodDays = 30;

    const consumptionMap = {};
    consumptionByItem.forEach(c => { consumptionMap[`${c._id.site}||${c._id.name}`] = c.total; });

    const stockForecast = inventory
      .map(i => {
        const consumed = consumptionMap[`${i.site_name}||${i.name}`] || 0;
        const avgDaily = consumed / periodDays;
        const daysLeft = avgDaily > 0 ? Math.floor(i.quantity / avgDaily) : null;
        let status;
        if (i.quantity <= 0) status = 'out';
        else if (daysLeft !== null && daysLeft <= 7) status = 'critical';
        else if ((daysLeft !== null && daysLeft <= 14) || i.quantity < i.low_stock_threshold) status = 'warning';
        else status = 'healthy';
        return {
          material_name: i.name,
          site_name: i.site_name,
          unit: i.unit,
          quantity: i.quantity,
          low_stock_threshold: i.low_stock_threshold,
          avg_daily_use: Math.round(avgDaily * 100) / 100,
          days_left: daysLeft,
          status,
        };
      })
      .sort((a, b) => {
        // most urgent first: out of stock, then fewest days left, then unknown
        const rank = (x) => x.quantity <= 0 ? -1 : (x.days_left === null ? Number.MAX_SAFE_INTEGER : x.days_left);
        return rank(a) - rank(b);
      })
      .slice(0, 15);

    // ── Slip stats ──────────────────────────────────────────────────────────
    const slipByStatus = Object.fromEntries(slipStatusAgg.map(s => [s._id, s]));
    const slipApproved = slipByStatus.approved?.count || 0;
    const slipRejected = slipByStatus.rejected?.count || 0;
    const slipPending = slipByStatus.pending?.count || 0;
    const slipDecided = slipApproved + slipRejected;

    // ── Order stats ─────────────────────────────────────────────────────────
    const orderByStatus = Object.fromEntries(orderStatusAgg.map(s => [s._id, s.count]));
    const ordAccepted = orderByStatus.accepted || 0;
    const ordRejected = orderByStatus.rejected || 0;
    const ordPending = orderByStatus.pending || 0;
    const ordDecided = ordAccepted + ordRejected;

    // ── Site comparison assembly ────────────────────────────────────────────
    const invBySite = Object.fromEntries(siteCmpInv.map(s => [s._id, s]));
    const siteComparison = siteCmpSlips.map(s => ({
      site_name: s._id,
      slips: s.slips,
      approved_slips: s.approved,
      pending_slips: s.pending,
      quantity_consumed: Math.round(s.quantity_consumed * 100) / 100,
      total_materials: invBySite[s._id]?.total_materials || 0,
      low_stock_count: invBySite[s._id]?.low_stock || 0,
      out_of_stock_count: invBySite[s._id]?.out_of_stock || 0,
    }));
    // Include sites that have inventory but no slips in range
    Object.keys(invBySite).forEach(name => {
      if (!siteComparison.find(s => s.site_name === name)) {
        siteComparison.push({
          site_name: name, slips: 0, approved_slips: 0, pending_slips: 0, quantity_consumed: 0,
          total_materials: invBySite[name].total_materials,
          low_stock_count: invBySite[name].low_stock,
          out_of_stock_count: invBySite[name].out_of_stock,
        });
      }
    });

    return res.json({
      success: true,
      message: 'OK',
      data: {
        site: site || 'All Sites',
        period_days: periodDays,
        inventory_health: {
          total: inventory.length,
          in_stock: inStock,
          low_stock: lowStock,
          out_of_stock: outOfStock,
        },
        top_consumed: topConsumed,
        consumption_trend: trend,
        stock_forecast: stockForecast,
        site_comparison: siteComparison,
        slip_stats: {
          total: slipApproved + slipRejected + slipPending,
          pending: slipPending,
          approved: slipApproved,
          rejected: slipRejected,
          approval_rate: slipDecided > 0 ? Math.round((slipApproved / slipDecided) * 100) : null,
          avg_approval_hours: slipByStatus.approved?.avg_hours != null
            ? Math.round(slipByStatus.approved.avg_hours * 10) / 10 : null,
        },
        order_stats: {
          total: ordAccepted + ordRejected + ordPending,
          pending: ordPending,
          accepted: ordAccepted,
          rejected: ordRejected,
          acceptance_rate: ordDecided > 0 ? Math.round((ordAccepted / ordDecided) * 100) : null,
        },
        by_manager: byManager,
      }
    });
  } catch (err) {
    console.error('[ANALYTICS ERROR]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
