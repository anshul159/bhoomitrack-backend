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

    // Old tokens (issued before orgId was added to makeToken) won't have orgId in the payload.
    // Fall back to a DB lookup so every endpoint that uses req.user.orgId still works correctly.
    if (!req.user.orgId) {
      try {
        const User = require('../models/User');
        const user = await User.findById(decoded.id).select('orgId').lean();
        if (user && user.orgId) req.user.orgId = user.orgId;
      } catch (_) { /* non-fatal — endpoint handles missing orgId */ }
    }

    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};
