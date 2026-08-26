// Site-scope guard (ENH-024).
//
// `GET /api/inventory/:site`, `/api/slips/:site`, `/api/slips/last/:site` and
// `/api/orders/:site` were guarded by `auth` alone. They filtered on `orgId` but
// never compared `:site` against the caller's own assignment, so an authenticated
// manager calling the API directly could read stock and slip history for any site
// in their company. The app always sent the right site, which is exactly why this
// went unnoticed — and exactly why it needed fixing: a rule enforced only by the
// client is not a rule, and BR-011 documented it as one.
//
// Resolves `req.params.site` (a name or an id) into `req.site` so handlers do not
// each repeat the lookup.

const { resolveSite } = require('../utils/site');

module.exports = async (req, res, next) => {
  try {
    const site = await resolveSite(req.params.site, req.user.orgId);
    if (!site) {
      return res.status(404).json({ success: false, message: 'Site not found' });
    }

    // Owners and super admins see every site in their own organisation.
    if (req.user.role === 'owner' || req.user.role === 'super_admin') {
      req.site = site;
      return next();
    }

    // Managers see only what they are assigned. `site_ids` is authoritative;
    // `site_name` covers managers whose assignment predates the id migration.
    const assignedIds = req.user.site_ids || [];
    const allowed =
      assignedIds.includes(String(site._id)) ||
      (req.user.site_name && req.user.site_name === site.name);

    if (!allowed) {
      return res.status(403).json({ success: false, message: 'You are not assigned to this site' });
    }

    req.site = site;
    next();
  } catch (err) {
    console.error('[SITE ACCESS]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
