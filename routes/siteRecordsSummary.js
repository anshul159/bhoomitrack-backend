const express = require('express');
const router = express.Router();
// No `auth` here on purpose — applied at the mount in server.js (PF-007).
const { ownerOnly } = require('../middleware/roles');
const { ValidationError } = require('../utils/siteRecords');
const { summarise } = require('../utils/recordsSummary');

// The owner's view across every site (v2): what was paid and what arrived, in
// total and site by site, for the owner home card and its breakdown.
//
// Its own path rather than /api/payments/summary, because that would shadow
// GET /api/payments/:site for a site that happens to be called "summary".

// ─── GET /api/site-records/summary ────────────────────────────────────────────
// Owner only: it covers every site. Optional ?from=&to= bound payments by the
// day they were paid and arrivals by the day they arrived. Void entries are left
// out, as in every other total. Every site is listed, including ones where
// nothing was recorded, because a site that recorded nothing is itself
// something an owner wants to see. See utils/recordsSummary.js for the rules.
router.get('/summary', ownerOnly, async (req, res) => {
  try {
    const data = await summarise(req.user.orgId, { from: req.query.from, to: req.query.to });
    return res.json({ success: true, message: 'OK', data });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ success: false, message: err.message });
    console.error('[SITE RECORDS SUMMARY]', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
