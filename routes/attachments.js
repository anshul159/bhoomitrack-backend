const express = require('express');
const router = express.Router();
// No `auth` here on purpose — applied at the mount in server.js (PF-007).
const Attachment = require('../models/Attachment');
const Site = require('../models/Site');
const { isObjectId } = require('../utils/validate');
const { isOwnerRole, mayManagerSee } = require('../utils/siteRecords');

// ─── GET /api/attachments/:id ─────────────────────────────────────────────────
// The image itself, for an authenticated caller in the same organisation. A
// manager may only fetch attachments from a site they are assigned to — the same
// rule as every other site-scoped read (ENH-024).
router.get('/:id', async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid attachment id' });

    const attachment = await Attachment.findOne({ _id: req.params.id, orgId: req.user.orgId }).select('+data');
    if (!attachment) return res.status(404).json({ success: false, message: 'Attachment not found' });

    if (!isOwnerRole(req.user)) {
      const site = await Site.findOne({ _id: attachment.site_id, orgId: req.user.orgId }, '_id name').lean();
      if (!site || !mayManagerSee(req.user, site)) {
        return res.status(403).json({ success: false, message: 'You are not assigned to this site' });
      }
    }

    // A bill never changes once stored, so the client may keep it — privately.
    res.set({
      'Content-Type': attachment.content_type,
      'Content-Length': String(attachment.size),
      'Cache-Control': 'private, max-age=604800, immutable',
      'Content-Disposition': 'inline',
    });
    // Not a lean read on purpose: hydrated, `data` is a real Node Buffer, whereas
    // lean hands back BSON Binary whose backing array can be longer than the image.
    return res.end(attachment.data);
  } catch (err) {
    console.error('[ATTACHMENT GET]', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
