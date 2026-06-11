/**
 * Middleware: ensures req.user.orgId is set before proceeding.
 * Users created via the old /signup path (no org) will be blocked
 * from data routes until they are associated with an organisation.
 */
module.exports = (req, res, next) => {
  if (!req.user || !req.user.orgId) {
    return res.status(403).json({
      success: false,
      message: 'Your account is not associated with any company. Please re-login or register your company.',
    });
  }
  next();
};
