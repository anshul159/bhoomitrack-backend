// Pagination helpers (ENH-015).
//
// List endpoints previously capped results (500, 200) and returned them as if
// complete — a busy site silently lost its oldest history. Every list endpoint
// now returns a `page` block alongside `data`, so a caller can always tell
// whether it is holding everything.
//
// Compatibility: `data` keeps its shape and default page sizes match or exceed
// the old caps, so existing app builds that ignore `page` behave as before.

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function parsePaging(query, { defaultLimit = DEFAULT_LIMIT } = {}) {
  const rawPage = Number(query?.page);
  const rawLimit = Number(query?.limit);

  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  let limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.floor(rawLimit) : defaultLimit;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  return { page, limit, skip: (page - 1) * limit };
}

function pageMeta({ page, limit, total }) {
  return {
    page,
    limit,
    total,
    total_pages: limit > 0 ? Math.ceil(total / limit) : 0,
    has_more: page * limit < total,
  };
}

/**
 * Every paged sort ends on `_id` so the order is total.
 *
 * Without it, records sharing a sort value — slips created in the same second,
 * two materials with the same name — have no defined order between them, and
 * skip/limit paging is free to return one twice and another not at all. That is
 * silent data loss in a list a customer is reading, and it only shows up under
 * exactly the conditions that matter: many records, created together.
 */
function stableSort(sort) {
  if (!sort || typeof sort !== 'object') return { _id: -1 };
  if ('_id' in sort) return sort;
  // Break ties in the same direction as the primary key, so the tie-break reads
  // as a continuation of the intended order rather than reversing within a group.
  const direction = Object.values(sort)[0] === 1 ? 1 : -1;
  return { ...sort, _id: direction };
}

/**
 * Runs a find + countDocuments pair and returns { data, page }.
 * `project` maps a lean document to its API shape.
 */
async function paginate(Model, filter, { page, limit, skip }, sort, project) {
  const [docs, total] = await Promise.all([
    Model.find(filter).sort(stableSort(sort)).skip(skip).limit(limit).lean(),
    Model.countDocuments(filter),
  ]);
  return { data: docs.map(project), page: pageMeta({ page, limit, total }) };
}

module.exports = { parsePaging, pageMeta, paginate, stableSort, DEFAULT_LIMIT, MAX_LIMIT };
