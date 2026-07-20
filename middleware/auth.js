const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../utils/token');

// Use async middleware so we can do a DB fallback for old tokens that predate orgId in the payload.
module.exports = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });

    // Handle "Bearer <token>" or just "<token>"
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;

    // Always resolve orgId fresh from the DB rather than trusting whatever's baked
    // into the token. Tokens live for 30 days, and a user's orgId can change after
    // theirs was issued (e.g. a legacy account backfilled with an orgId by a later
    // migration) — trusting a stale token value here silently broke every org-scoped
    // query (pending approvals, managers list, etc.) with an empty result instead of
    // an error, since the query itself looked perfectly valid.
    try {
      const User = require('../models/User');
      const user = await User.findById(decoded.id).select('orgId').lean();
      if (user && user.orgId) req.user.orgId = user.orgId;
    } catch (_) { /* non-fatal — endpoint handles missing orgId */ }

    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};
