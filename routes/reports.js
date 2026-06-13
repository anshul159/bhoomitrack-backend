const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const auth = require('../middleware/auth');
const { ownerOnly } = require('../middleware/roles');
const Slip = require('../models/Slip');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const Site = require('../models/Site');

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

    // Convert orgId string to ObjectId for use in aggregation $match stages
    const orgOid = new mongoose.Types.ObjectId(req.user.orgId);

    const rangeMatch = since ? { createdAt: { $gte: since } } : {};
    const siteMatch = site ? { site_name: site } : {};
    const orgMatch = { orgId: orgOid };
    const slipMatchAll = { ...rangeMatch, ...siteMatch, ...orgMatch };          // slips, any status
    const slipMatchApproved = { ...slipMatchAll, status: 'approved' };          // consumption = approved only
    const orderMatchAll = { ...rangeMatch, ...siteMatch, ...orgMatch };

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
      lastConsumed,
      burnAgg,
      pendingOrdersList,
      orderDecisionAgg,
      reorderFreq,
      slipLastBySite,
      orderLastBySite,
      allSites,
    ] = await Promise.all([

      // Inventory for the scope (health + forecast) — scoped to this org
      Inventory.find({ ...siteMatch, orgId: req.user.orgId }).lean(),

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
        { $match: orderMatchAll },
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

      // 7a. Site comparison — slip activity per site (all sites, range only, scoped to this org)
      site ? Promise.resolve([]) : Slip.aggregate([
        { $match: { ...rangeMatch, ...orgMatch } },
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

      // 7b. Site comparison — low stock per site (scoped to this org)
      site ? Promise.resolve([]) : Inventory.aggregate([
        { $match: orgMatch },
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

      // 9. Last consumption date per site+material — ALL TIME (drives idle-stock)
      Slip.aggregate([
        { $match: { ...siteMatch, ...orgMatch, status: 'approved' } },
        { $unwind: '$items' },
        {
          $group: {
            _id: { site: '$site_name', name: '$items.material_name' },
            last_used: { $max: '$createdAt' },
          }
        },
      ]),

      // 10. Burn rate — last 7 days vs previous 7 days, per site+material
      Slip.aggregate([
        { $match: { ...siteMatch, ...orgMatch, status: 'approved', createdAt: { $gte: new Date(Date.now() - 14 * 86400000) } } },
        { $unwind: '$items' },
        {
          $group: {
            _id: { site: '$site_name', name: '$items.material_name', unit: '$items.unit' },
            last7: { $sum: { $cond: [{ $gte: ['$createdAt', new Date(Date.now() - 7 * 86400000)] }, '$items.quantity_taken', 0] } },
            prev7: { $sum: { $cond: [{ $lt: ['$createdAt', new Date(Date.now() - 7 * 86400000)] }, '$items.quantity_taken', 0] } },
          }
        },
        { $sort: { last7: -1 } },
        { $limit: 12 },
      ]),

      // 11. Pending orders (ageing + "ordering what you already own")
      Order.find({ ...siteMatch, ...orgMatch, status: 'pending' }).sort({ createdAt: 1 }).limit(50).lean(),

      // 12. Avg order decision time (accepted/rejected in range)
      Order.aggregate([
        { $match: { ...orderMatchAll, status: { $in: ['accepted', 'rejected'] } } },
        {
          $group: {
            _id: null,
            avg_hours: { $avg: { $divide: [{ $subtract: ['$updatedAt', '$createdAt'] }, 3600000] } },
            count: { $sum: 1 },
          }
        },
      ]),

      // 13. Frequently re-ordered materials
      Order.aggregate([
        { $match: orderMatchAll },
        { $group: { _id: '$material_name', orders: { $sum: 1 }, total_qty: { $sum: '$quantity' } } },
        { $sort: { orders: -1 } },
        { $limit: 8 },
        { $project: { _id: 0, material_name: '$_id', orders: 1, total_qty: 1 } },
      ]),

      // 14. Last slip activity per site — ALL TIME (stalled-site detection)
      Slip.aggregate([
        { $match: orgMatch },
        { $group: { _id: '$site_name', last: { $max: '$createdAt' } } },
      ]),

      // 15. Last order activity per site — ALL TIME
      Order.aggregate([
        { $match: orgMatch },
        { $group: { _id: '$site_name', last: { $max: '$createdAt' } } },
      ]),

      // 16. All sites in org (complete list for stalled detection)
      Site.find({ orgId: req.user.orgId }).select('name').lean(),
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

    // ── Idle / dead stock ────────────────────────────────────────────────────
    // "idle" = has stock on hand but hasn't been consumed in 30+ days
    const lastConsumedMap = {};
    lastConsumed.forEach(r => { lastConsumedMap[`${r._id.site}||${r._id.name}`] = r.last_used; });

    const now = Date.now();
    const idleStock = inventory
      .filter(i => i.quantity > 0)
      .map(i => {
        const key = `${i.site_name}||${i.name}`;
        const last = lastConsumedMap[key] ? new Date(lastConsumedMap[key]).getTime() : null;
        const daysSinceUse = last ? Math.floor((now - last) / 86400000) : 9999;
        return {
          material_name: i.name,
          site_name: i.site_name,
          quantity: i.quantity,
          unit: i.unit,
          days_since_use: daysSinceUse,
          never_used: !last,
        };
      })
      .filter(i => i.days_since_use >= 30)
      .sort((a, b) => b.days_since_use - a.days_since_use)
      .slice(0, 20);

    // ── Transfer suggestions (cross-site imbalance) ──────────────────────────
    // Same material: idle (30+ days) at one site, critical/low at another
    const forecastMap = {};
    const allForecast = inventory.map(i => {
      const consumed = consumptionMap[`${i.site_name}||${i.name}`] || 0;
      const avgDaily = consumed / periodDays;
      const daysLeft = avgDaily > 0 ? Math.floor(i.quantity / avgDaily) : null;
      let status;
      if (i.quantity <= 0) status = 'out';
      else if (daysLeft !== null && daysLeft <= 7) status = 'critical';
      else if ((daysLeft !== null && daysLeft <= 14) || i.quantity < i.low_stock_threshold) status = 'warning';
      else status = 'healthy';
      const isIdle = (lastConsumedMap[`${i.site_name}||${i.name}`]
        ? Math.floor((now - new Date(lastConsumedMap[`${i.site_name}||${i.name}`]).getTime()) / 86400000)
        : 9999) >= 30;
      const rec = { site_name: i.site_name, quantity: i.quantity, unit: i.unit, avg_daily: Math.round(avgDaily * 100) / 100, days_left: daysLeft, status, is_idle: isIdle };
      if (!forecastMap[i.name]) forecastMap[i.name] = [];
      forecastMap[i.name].push(rec);
      return { name: i.name, ...rec };
    });

    const transferSuggestions = [];
    for (const [matName, sites] of Object.entries(forecastMap)) {
      const donors = sites.filter(s => s.is_idle && s.quantity > 0);
      const receivers = sites.filter(s => s.status === 'critical' || s.status === 'out');
      donors.forEach(donor => {
        receivers.forEach(receiver => {
          if (donor.site_name !== receiver.site_name) {
            const suggestQty = receiver.avg_daily > 0
              ? Math.min(donor.quantity, Math.ceil(receiver.avg_daily * 14))
              : Math.min(donor.quantity, Math.ceil(donor.quantity / 2));
            transferSuggestions.push({
              material_name: matName,
              unit: donor.unit,
              from_site: donor.site_name,
              from_qty: donor.quantity,
              to_site: receiver.site_name,
              to_days_left: receiver.days_left,
              suggested_transfer_qty: suggestQty,
            });
          }
        });
      });
    }
    transferSuggestions.sort((a, b) => (a.to_days_left ?? 0) - (b.to_days_left ?? 0));

    // ── Overstock detection ──────────────────────────────────────────────────
    // months-of-cover = quantity / (avgDaily * 30). Flag > 3 months.
    const overstock = allForecast
      .filter(i => {
        if (i.avg_daily <= 0) return false;
        const monthsCover = i.quantity / (i.avg_daily * 30);
        return monthsCover > 3;
      })
      .map(i => {
        const monthsCover = Math.round((i.quantity / (i.avg_daily * 30)) * 10) / 10;
        return {
          material_name: i.name,
          site_name: i.site_name,
          quantity: i.quantity,
          unit: i.unit,
          avg_daily: i.avg_daily,
          months_of_cover: monthsCover,
        };
      })
      .sort((a, b) => b.months_of_cover - a.months_of_cover)
      .slice(0, 10);

    // ── Burn rate WoW change ─────────────────────────────────────────────────
    const burnRateItems = burnAgg.map(b => {
      const pct = b.prev7 > 0 ? Math.round(((b.last7 - b.prev7) / b.prev7) * 100) : null;
      return {
        material_name: b._id.name,
        site_name: b._id.site,
        unit: b._id.unit,
        last_7_days: Math.round(b.last7 * 100) / 100,
        prev_7_days: Math.round(b.prev7 * 100) / 100,
        wow_change_pct: pct,
        spike: pct !== null && pct >= 50,
      };
    });

    // ── Order ageing + "ordering what you own" flag ──────────────────────────
    const idleByMaterial = {};
    idleStock.forEach(i => {
      if (!idleByMaterial[i.material_name]) idleByMaterial[i.material_name] = [];
      idleByMaterial[i.material_name].push({ site: i.site_name, qty: i.quantity, unit: i.unit });
    });
    const orderAgeing = pendingOrdersList.map(o => {
      const hoursPending = Math.round((now - new Date(o.createdAt).getTime()) / 3600000);
      const idleElsewhere = (idleByMaterial[o.material_name] || [])
        .filter(i => i.site !== o.site_name);
      return {
        material_name: o.material_name,
        site_name: o.site_name,
        quantity_requested: o.quantity,
        unit: o.unit,
        requested_by: o.requested_by,
        hours_pending: hoursPending,
        idle_elsewhere: idleElsewhere,
        has_idle_elsewhere: idleElsewhere.length > 0,
        created_at: o.createdAt,
      };
    }).sort((a, b) => b.hours_pending - a.hours_pending);

    // ── Order decision turnaround ────────────────────────────────────────────
    const avgOrderDecisionHours = orderDecisionAgg[0]
      ? Math.round(orderDecisionAgg[0].avg_hours * 10) / 10 : null;

    // ── Stalled sites ────────────────────────────────────────────────────────
    const slipLastBySiteMap = Object.fromEntries(slipLastBySite.map(s => [s._id, s.last]));
    const orderLastBySiteMap = Object.fromEntries(orderLastBySite.map(s => [s._id, s.last]));
    const STALL_DAYS = 14;
    const stalledSites = allSites.map(s => {
      const lastSlip = slipLastBySiteMap[s.name] ? new Date(slipLastBySiteMap[s.name]).getTime() : null;
      const lastOrder = orderLastBySiteMap[s.name] ? new Date(orderLastBySiteMap[s.name]).getTime() : null;
      const lastActivity = lastSlip && lastOrder ? Math.max(lastSlip, lastOrder) : (lastSlip || lastOrder);
      const daysSilent = lastActivity ? Math.floor((now - lastActivity) / 86400000) : null;
      return {
        site_name: s.name,
        days_silent: daysSilent,
        last_slip: slipLastBySiteMap[s.name] || null,
        last_order: orderLastBySiteMap[s.name] || null,
        stalled: daysSilent === null || daysSilent >= STALL_DAYS,
      };
    }).filter(s => s.stalled).sort((a, b) => (b.days_silent ?? 9999) - (a.days_silent ?? 9999));

    // ── KPI summary (always-visible strip) ───────────────────────────────────
    const stockoutRiskCount = allForecast.filter(i => i.status === 'critical' || i.status === 'out').length;
    const idleStockCount = idleStock.length;
    const pendingApprovalsTotal = (inventory.length > 0 ? 0 : 0) + // placeholder init
      // slip pending + order pending — already computed above
      (slipPending || 0) + (ordPending || 0);
    const totalConsumption = topConsumed.reduce((s, c) => s + c.total_taken, 0);

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

        // ── Always-visible KPI strip ────────────────────────────────────────
        kpis: {
          stockout_risk_count: stockoutRiskCount,
          idle_stock_count: idleStockCount,
          pending_approvals: { slips: slipPending, orders: ordPending, total: pendingApprovalsTotal },
          total_consumption: Math.round(totalConsumption * 100) / 100,
        },

        // ── Inventory health (summary) ──────────────────────────────────────
        inventory_health: {
          total: inventory.length,
          in_stock: inStock,
          low_stock: lowStock,
          out_of_stock: outOfStock,
        },

        // ── TAB 1: Cross-site stock intelligence ───────────────────────────
        stock_intelligence: {
          idle_stock: idleStock,                   // dead stock ≥30 days no movement
          transfer_suggestions: transferSuggestions.slice(0, 12),  // idle→critical cross-site moves
          stockout_risk: stockForecast,            // ranked worst-first (reused)
          overstock: overstock,                   // >3 months cover
        },

        // ── TAB 2: Consumption intelligence ───────────────────────────────
        consumption: {
          top_consumed: topConsumed,              // top movers
          slow_movers: inventory                  // items with no consumption in range
            .filter(i => !consumptionMap[`${i.site_name}||${i.name}`])
            .slice(0, 10)
            .map(i => ({ material_name: i.name, site_name: i.site_name, quantity: i.quantity, unit: i.unit })),
          burn_rate: burnRateItems,               // WoW change per material/site
          trend: trend,                           // daily totals chart
          site_comparison: siteComparison,        // per-site efficiency
        },

        // ── TAB 3: Procurement & orders ────────────────────────────────────
        procurement: {
          order_ageing: orderAgeing,              // pending orders sorted by age
          avg_decision_hours: avgOrderDecisionHours,
          reorder_frequency: reorderFreq,         // candidates for bulk buy
          order_stats: {
            total: ordAccepted + ordRejected + ordPending,
            pending: ordPending,
            accepted: ordAccepted,
            rejected: ordRejected,
            acceptance_rate: ordDecided > 0 ? Math.round((ordAccepted / ordDecided) * 100) : null,
          },
        },

        // ── TAB 4: Accountability ──────────────────────────────────────────
        accountability: {
          by_manager: byManager,
          stalled_sites: stalledSites,
          slip_stats: {
            total: slipApproved + slipRejected + slipPending,
            pending: slipPending,
            approved: slipApproved,
            rejected: slipRejected,
            approval_rate: slipDecided > 0 ? Math.round((slipApproved / slipDecided) * 100) : null,
            avg_approval_hours: slipByStatus.approved?.avg_hours != null
              ? Math.round(slipByStatus.approved.avg_hours * 10) / 10 : null,
          },
        },

        // ── Legacy top-level fields (keep for any existing callers) ────────
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
