const jwt = require('jsonwebtoken');

// JWT secret MUST come from environment — no hardcoded fallback.
// server.js validates its presence at startup.
const JWT_SECRET = process.env.JWT_SECRET;

const makeToken = (user) => jwt.sign(
  { id: user._id, role: user.role, name: user.name, orgId: user.orgId },
  JWT_SECRET,
  { expiresIn: '30d' }
);

module.exports = { makeToken, JWT_SECRET };
