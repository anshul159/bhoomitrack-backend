// Audit-trail writer (ENH-008).
//
// Recording an action must never be the reason a request fails: a slip approval
// that succeeded but whose audit row could not be written is still an approval,
// and turning that into a 500 would be worse than the missing row. So every
// failure here is logged and swallowed. Callers therefore do not await unless
// they specifically want the row persisted before responding.

const AuditLog = require('../models/AuditLog');

/**
 * @param {object} req    the request, for actor identity (req.user)
 * @param {object} entry  { action, entity, entity_id, entity_label, site_id, site_name, before, after, note }
 */
async function record(req, entry) {
  try {
    await AuditLog.create({
      orgId: req.user.orgId,
      actor_id: req.user.id,
      actor_name: req.user.name || '',
      actor_role: req.user.role || '',
      ...entry,
    });
  } catch (err) {
    console.error('[AUDIT] Failed to record', entry?.action, '-', err.message);
  }
}

// Reduces two documents to just the fields that differ, so the log stores a
// change rather than two full copies of a record.
function diff(before, after, fields) {
  const b = {};
  const a = {};
  for (const f of fields) {
    const bv = before?.[f];
    const av = after?.[f];
    if (String(bv) !== String(av)) { b[f] = bv; a[f] = av; }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

module.exports = { record, diff };
