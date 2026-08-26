// Subscription gate (ENH-003).
//
// Sits on the data routes, after requireOrgId. An organisation whose trial has
// lapsed, whose payment is overdue, or which has been suspended keeps its data
// and its login — it simply cannot read or write through the API until the
// situation is resolved.
//
// 402 Payment Required is used deliberately so the app can tell this apart from
// an authorisation failure and show a billing screen rather than "access denied".
//
// Owners and super admins keep access to the billing and export routes, which are
// mounted outside this gate on purpose: a customer must always be able to see
// what they owe and take their data with them.

const Organization = require('../models/Organization');

module.exports = async (req, res, next) => {
  try {
    const org = await Organization.findById(req.user.orgId);
    if (!org) {
      return res.status(403).json({ success: false, message: 'Your organisation no longer exists' });
    }

    if (!org.isActive()) {
      return res.status(402).json({
        success: false,
        code: 'subscription_inactive',
        status: org.status,
        message: org.inactiveReason(),
      });
    }

    req.org = org;
    next();
  } catch (err) {
    console.error('[ORG GATE]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
