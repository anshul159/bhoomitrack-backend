// Site resolution and the transitional site filter (ENH-007).
//
// Historically Inventory, Slip and Order referenced a site by the *string*
// `site_name`, which meant renaming a site would orphan every record attached to
// it. Those collections now carry `site_id` as well.
//
// Two things follow:
//
//  1. Route params stay name-based, because app builds already in customers'
//     hands send a name. `resolveSite` accepts either a name or an id.
//  2. Queries match on `site_id` OR the denormalised `site_name`. The migration
//     (migrate-site-ids.js) backfills every existing row, but the OR keeps rows
//     written between deploy and migration — and any row the migration could not
//     match — visible rather than silently missing.

const mongoose = require('mongoose');
const Site = require('../models/Site');

/**
 * Resolves a `:site` path parameter within one organisation.
 * @returns {Promise<{_id, name, location}|null>}
 */
async function resolveSite(siteParam, orgId) {
  if (siteParam === undefined || siteParam === null || siteParam === '') return null;
  const value = String(siteParam);

  if (mongoose.Types.ObjectId.isValid(value)) {
    const byId = await Site.findOne({ _id: value, orgId }).lean();
    if (byId) return byId;
    // A 24-hex site *name* is far-fetched, but falling through costs nothing.
  }
  return Site.findOne({ name: value, orgId }).lean();
}

/**
 * Filter matching records belonging to `site`, by id or by denormalised name.
 * Always combine with orgId — this helper does not add it.
 */
function siteFilter(site) {
  return { $or: [{ site_id: site._id }, { site_name: site.name }] };
}

/**
 * Filter for a set of sites (used for multi-site managers, ENH-016).
 */
function sitesFilter(sites) {
  return {
    $or: [
      { site_id: { $in: sites.map((s) => s._id) } },
      { site_name: { $in: sites.map((s) => s.name) } },
    ],
  };
}

module.exports = { resolveSite, siteFilter, sitesFilter };
