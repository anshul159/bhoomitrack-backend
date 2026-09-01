// Turning a database uniqueness collision into something a person can act on.
//
// The unique indexes added for PF-001 and PF-002 are what actually close those
// races — a pre-insert lookup cannot, because there is always a gap between the
// check and the write. But an index rejects a duplicate by throwing E11000, and an
// unhandled E11000 reaches the generic catch and becomes `500 Server error`.
//
// That would be a bad trade: we would have swapped silent data corruption for a
// server error on a form the user filled in correctly-but-late. This maps the
// collision back to the message the route would have shown if its own pre-check had
// won the race, so the two paths are indistinguishable from the outside.

const DUPLICATE_MESSAGES = {
  email_unique_active: 'An account with this email already exists',
  phone_unique_active: 'An account with this phone number already exists',
  org_site_name_unique: 'Site with this name already exists',
};

/** True if this error is a MongoDB duplicate-key rejection. */
function isDuplicateKeyError(err) {
  return Boolean(err) && (err.code === 11000 || err.code === 11001);
}

/**
 * The user-facing message for a duplicate-key error, or null if the error is
 * something else and should keep travelling to the 500 handler.
 *
 * Matches on index name first because it is exact. Falls back to the offending key
 * so that an index added later still produces something sensible rather than a 500.
 */
function duplicateKeyMessage(err) {
  if (!isDuplicateKeyError(err)) return null;

  const byName = DUPLICATE_MESSAGES[err.message?.match(/index: (\w+)/)?.[1]];
  if (byName) return byName;

  const field = Object.keys(err.keyPattern || {}).filter((f) => f !== 'orgId')[0];
  if (field === 'email') return DUPLICATE_MESSAGES.email_unique_active;
  if (field === 'phone') return DUPLICATE_MESSAGES.phone_unique_active;
  if (field === 'name') return DUPLICATE_MESSAGES.org_site_name_unique;

  return 'That already exists';
}

/**
 * Answers a duplicate-key error on `res` and reports whether it did.
 *
 * 409 rather than 400: the request was well-formed and the conflict is with the
 * current state of the data, which is exactly what 409 means. The client treats any
 * non-2xx the same way, so this costs nothing and tells the truth in a log.
 */
function respondIfDuplicate(res, err) {
  const message = duplicateKeyMessage(err);
  if (!message) return false;
  res.status(409).json({ success: false, message });
  return true;
}

module.exports = { isDuplicateKeyError, duplicateKeyMessage, respondIfDuplicate };
