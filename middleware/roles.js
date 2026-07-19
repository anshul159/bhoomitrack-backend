// Role-based authorisation middleware.
// Usage: router.get('/pending', auth, requireRole('owner', 'super_admin'), handler)
// Relies on auth middleware having set req.user from the verified JWT.
const requireRole = (...allowedRoles) => (req, res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'You do not have permission to perform this action' });
  }
  next();
};

module.exports = { requireRole };
