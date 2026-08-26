const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { ownerOnly } = require('../middleware/roles');
const AuditLog = require('../models/AuditLog');
const { resolveSite, siteFilter } = require('../utils/site');
const { parsePaging, paginate } = require('../utils/pagination');
const { isNonEmptyString, isObjectId } = require('../utils/validate');

// Owner-facing view of the audit trail (ENH-008).
//
// The product's value in a dispute — "the manager says he took four bags, the
// register says nine" — depends on being able to show what changed and who
// changed it. Read-only by design: there is no endpoint that edits or deletes a
// row, here or anywhere else.

const entryToResponse = (e) => ({
  id: e._id,
  action: e.action,
  entity: e.entity,
  entity_id: e.entity_id,
  entity_label: e.entity_label,
  actor_id: e.actor_id,
  actor_name: e.actor_name,
  actor_role: e.actor_role,
  site_id: e.site_id,
  site_name: e.site_name,
  before: e.before,
  after: e.after,
  note: e.note,
  created_at: e.createdAt,
});

// ─── GET /api/audit ───────────────────────────────────────────────────────────
// Filters: ?entity=inventory &action=inventory.update &site=<name|id>
//          &entity_id=<id> &from=<iso> &to=<iso> &page= &limit=
router.get('/', auth, ownerOnly, async (req, res) => {
  try {
    const filter = { orgId: req.user.orgId };

    if (isNonEmptyString(req.query.entity, 40)) filter.entity = req.query.entity;
    if (isNonEmptyString(req.query.action, 60)) filter.action = req.query.action;
    if (isObjectId(req.query.entity_id)) filter.entity_id = req.query.entity_id;

    if (isNonEmptyString(req.query.site, 200)) {
      const site = await resolveSite(req.query.site, req.user.orgId);
      if (!site) return res.json({ success: true, message: 'OK', data: [], page: { page: 1, limit: 0, total: 0, total_pages: 0, has_more: false } });
      Object.assign(filter, siteFilter(site));
    }

    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;
    if ((from && !Number.isNaN(from.valueOf())) || (to && !Number.isNaN(to.valueOf()))) {
      filter.createdAt = {};
      if (from && !Number.isNaN(from.valueOf())) filter.createdAt.$gte = from;
      if (to && !Number.isNaN(to.valueOf())) filter.createdAt.$lte = to;
    }

    const paging = parsePaging(req.query, { defaultLimit: 100 });
    const result = await paginate(AuditLog, filter, paging, { createdAt: -1 }, entryToResponse);
    return res.json({ success: true, message: 'OK', ...result });
  } catch (err) {
    console.error('[AUDIT LIST]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /api/audit/entity/:entity/:id ────────────────────────────────────────
// The full history of one record — "show me everything that happened to this
// material" is the question an owner actually asks.
router.get('/entity/:entity/:id', auth, ownerOnly, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    const paging = parsePaging(req.query, { defaultLimit: 100 });
    const filter = {
      orgId: req.user.orgId,
      entity: req.params.entity,
      entity_id: req.params.id,
    };
    const result = await paginate(AuditLog, filter, paging, { createdAt: -1 }, entryToResponse);
    return res.json({ success: true, message: 'OK', ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
