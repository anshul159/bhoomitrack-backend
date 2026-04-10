const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Slip = require('../models/Slip');
const Inventory = require('../models/Inventory');

// Helper to format slip for API response
function formatSlip(slip) {
  return {
    id: slip._id,
    site_name: slip.site_name,
    manager_id: slip.manager_id,
    manager_name: slip.manager_name,
    items: slip.items,
    status: slip.status,
    created_at: slip.createdAt,
  };
}

// ─── POST /api/slips/generate ─────────────────────────────────────────────────
// Creates slip as PENDING — does NOT touch inventory until owner approves
router.post('/generate', auth, async (req, res) => {
  try {
    const { site_name, items } = req.body;
    const slipItems = [];

    for (const item of items) {
      const inv = await Inventory.findById(item.inventory_id);
      if (!inv) continue;
      // Pre-compute what the stock would be after approval (for display only)
      const projectedStock = Math.max(0, inv.quantity - item.quantity_taken);
      slipItems.push({
        material_name: inv.name,
        quantity_taken: item.quantity_taken,
        unit: inv.unit,
        updated_stock: projectedStock,   // informational only until approved
        inventory_id: inv._id,
      });
    }

    const slip = await Slip.create({
      site_name,
      manager_id: req.user.id,
      manager_name: req.user.name,
      items: slipItems,
      status: 'pending',
    });

    return res.json({ success: true, message: 'Slip generated and awaiting owner approval', data: formatSlip(slip) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/slips/pending ───────────────────────────────────────────────────
// Owner: get all pending slips across all sites
router.get('/pending', auth, async (req, res) => {
  try {
    const slips = await Slip.find({ status: 'pending' }).sort({ createdAt: -1 });
    return res.json({ success: true, message: 'OK', data: slips.map(formatSlip) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/slips/approve/:id ───────────────────────────────────────────────
// Owner: approve a pending slip — deducts inventory NOW
router.put('/approve/:id', auth, async (req, res) => {
  try {
    const slip = await Slip.findById(req.params.id);
    if (!slip) return res.status(404).json({ success: false, message: 'Slip not found' });
    if (slip.status !== 'pending') return res.status(400).json({ success: false, message: `Slip is already ${slip.status}` });

    // Deduct inventory for each item
    for (const item of slip.items) {
      const inv = await Inventory.findById(item.inventory_id);
      if (!inv) continue;
      const newQty = Math.max(0, inv.quantity - item.quantity_taken);
      await Inventory.findByIdAndUpdate(item.inventory_id, { quantity: newQty });
      item.updated_stock = newQty; // keep in sync
    }

    slip.status = 'approved';
    await slip.save();

    return res.json({ success: true, message: 'Slip approved and inventory updated', data: formatSlip(slip) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUT /api/slips/reject/:id ────────────────────────────────────────────────
// Owner: reject a pending slip — no inventory change
router.put('/reject/:id', auth, async (req, res) => {
  try {
    const slip = await Slip.findById(req.params.id);
    if (!slip) return res.status(404).json({ success: false, message: 'Slip not found' });
    if (slip.status !== 'pending') return res.status(400).json({ success: false, message: `Slip is already ${slip.status}` });

    slip.status = 'rejected';
    await slip.save();

    return res.json({ success: true, message: 'Slip rejected', data: formatSlip(slip) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/slips/:site ─────────────────────────────────────────────────────
router.get('/:site', auth, async (req, res) => {
  try {
    const slips = await Slip.find({ site_name: req.params.site }).sort({ createdAt: -1 });
    return res.json({ success: true, message: 'OK', data: slips.map(formatSlip) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/slips/last/:site ────────────────────────────────────────────────
router.get('/last/:site', auth, async (req, res) => {
  try {
    const slip = await Slip.findOne({ site_name: req.params.site }).sort({ createdAt: -1 });
    if (!slip) return res.json({ success: false, message: 'No slips found', data: null });
    return res.json({ success: true, message: 'OK', data: formatSlip(slip) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
