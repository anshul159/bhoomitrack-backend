// Role-based authorization middleware.
// Usage: router.post('/approve', auth, requireRole('owner', 'super_admin'), handler)
// Must be used AFTER the auth middleware (relies on req.user set from the JWT).

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'You are not authorized to perform this action' });
  }
  next();
};

// Convenience guards
const ownerOnly = requireRole('owner', 'super_admin');

// Managers must be APPROVED before performing write actions (slips, orders).
// Tokens are issued at registration (the app needs them for the pending-approval
// flow), so approval has to be re-checked in the database for sensitive writes.
const requireApproved = async (req, res, next) => {
  try {
    if (req.user.role !== 'manager') return next(); // owners/super admins pass through
    const User = require('../models/User');
    const user = await User.findById(req.user.id).select('status').lean();
    if (!user || user.status !== 'approved') {
      return res.status(403).json({ success: false, message: 'Your account is not approved yet' });
    }
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = { requireRole, ownerOnly, requireApproved };
