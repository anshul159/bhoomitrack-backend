const jwt = require('jsonwebtoken');

// JWT secret MUST come from environment — no hardcoded fallback.
// server.js validates its presence at startup.
const JWT_SECRET = process.env.JWT_SECRET;

const TOKEN_TTL = process.env.JWT_TTL || '30d';

// Thirty days is right for a phone the owner carries. It is a long time for a
// browser on a laptop that may not be theirs alone, so the web console gets its
// own, shorter life (WEB-APP-PLAN §4.3).
const WEB_TOKEN_TTL = process.env.WEB_JWT_TTL || '12h';

// `tv` carries the user's tokenVersion (ENH-012). middleware/auth.js compares it
// against the stored value on every request — which it can do for free, since it
// already reads the user row to resolve orgId — so logging out, changing a role
// or removing someone from a site invalidates their outstanding tokens at once
// instead of leaving them valid for up to thirty days.
// `ttl` is optional: every existing caller passes nothing and behaves exactly as
// before.
const makeToken = (user, ttl) => jwt.sign(
  {
    id: user._id,
    role: user.role,
    name: user.name,
    orgId: user.orgId,
    tv: user.tokenVersion || 0,
  },
  JWT_SECRET,
  { expiresIn: ttl || TOKEN_TTL }
);

module.exports = { makeToken, JWT_SECRET, TOKEN_TTL, WEB_TOKEN_TTL };
