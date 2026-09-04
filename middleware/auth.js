const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../utils/token');

// Verifies the JWT, then reconciles it against the user row.
//
// This middleware has always read the user from the database — originally just to
// resolve `orgId`, because a token can outlive a change to the user it describes.
// That same read now also enforces token revocation (ENH-012) and account
// deletion (ENH-013), and loads site assignments for the site guard (ENH-024),
// so the extra guarantees cost no extra query.
module.exports = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ success: false, message: 'No token provided' });

    // Handle "Bearer <token>" or just "<token>"
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;

    const User = require('../models/User');
    let user = null;
    try {
      user = await User.findById(decoded.id)
        .select('orgId role tokenVersion deletedAt site_ids site_name name status webAppAccess')
        .lean();
    } catch (_) {
      // A database blip must not read as "your token is bad" — fall through and
      // let the endpoint deal with whatever it can from the token alone.
    }

    if (user) {
      if (user.deletedAt) {
        return res.status(401).json({ success: false, message: 'This account has been deleted' });
      }

      // ENH-012 — a token issued before the user's last logout/role change is dead.
      const tokenVersion = Number(decoded.tv || 0);
      if (Number(user.tokenVersion || 0) > tokenVersion) {
        return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
      }

      // Always prefer the stored values over whatever the token was minted with.
      if (user.orgId) req.user.orgId = user.orgId;
      req.user.role = user.role;
      req.user.name = user.name || req.user.name;
      req.user.status = user.status;
      req.user.site_ids = (user.site_ids || []).map(String);
      req.user.site_name = user.site_name || '';
      // Read live, so revoking web access takes effect on the NEXT REQUEST rather
      // than at the next login — and without bumping tokenVersion, which would
      // also sign the owner out of their phone for a web-only change.
      req.user.webAppAccess = Boolean(user.webAppAccess);
    }

    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};
