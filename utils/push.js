// Firebase Cloud Messaging — push notifications to owners (new pending slip)
// and managers (slip approved/rejected).
//
// Lazily initialized from FIREBASE_SERVICE_ACCOUNT_BASE64 (a base64-encoded
// service-account JSON key, so it survives as a single-line Render env var).
// If that var isn't set, every send is a silent no-op — push is a nice-to-have
// enhancement on top of the app's normal polling/pull-to-refresh, not a hard
// dependency, so a missing/misconfigured key must never break the API routes
// that call these helpers.

const admin = require('firebase-admin');

let app = null;
let initAttempted = false;

function getApp() {
  if (initAttempted) return app;
  initAttempted = true;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!b64) {
    console.warn('[PUSH] FIREBASE_SERVICE_ACCOUNT_BASE64 not set — push notifications disabled.');
    return null;
  }
  try {
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(json);
    app = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('[PUSH] Firebase Admin initialized.');
  } catch (err) {
    console.error('[PUSH] Failed to initialize Firebase Admin — push notifications disabled.', err.message);
    app = null;
  }
  return app;
}

// Firebase reports these when a token belongs to an app that has been uninstalled
// or whose token was replaced. Such tokens are dead forever and get pruned.
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Sends to one or more device tokens.
 * @returns {Promise<string[]>} tokens Firebase reported as permanently dead.
 */
async function sendToTokens(tokens, title, body, data = {}) {
  const firebaseApp = getApp();
  const validTokens = [...new Set((tokens || []).filter((t) => typeof t === 'string' && t.length > 0))];
  if (!firebaseApp || validTokens.length === 0) return [];

  try {
    const res = await admin.messaging(firebaseApp).sendEachForMulticast({
      tokens: validTokens,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high' },
    });

    const dead = [];
    res.responses.forEach((r, i) => {
      if (!r.success && DEAD_TOKEN_CODES.has(r.error?.code)) dead.push(validTokens[i]);
    });
    return dead;
  } catch (err) {
    console.error('[PUSH] Send failed:', err.message);
    return [];
  }
}

/**
 * Sends to every device each user has registered (ENH-014), then prunes the
 * tokens Firebase says are dead so the list does not grow forever.
 *
 * `users` may be lean docs or full documents; both `fcmTokens` (current) and the
 * legacy single `fcmToken` string are read, so a user who has not logged in since
 * the migration still receives push.
 */
async function sendToUsers(users, title, body, data = {}) {
  const list = users || [];
  const tokens = [];
  for (const u of list) {
    if (Array.isArray(u?.fcmTokens)) tokens.push(...u.fcmTokens.map((t) => t.token).filter(Boolean));
    if (u?.fcmToken) tokens.push(u.fcmToken); // legacy field, pre-migration rows
  }

  const dead = await sendToTokens(tokens, title, body, data);
  if (dead.length > 0) {
    try {
      const User = require('../models/User');
      await User.updateMany(
        { _id: { $in: list.map((u) => u._id).filter(Boolean) } },
        { $pull: { fcmTokens: { token: { $in: dead } } } }
      );
    } catch (err) {
      console.error('[PUSH] Failed to prune dead tokens:', err.message);
    }
  }
}

module.exports = { sendToTokens, sendToUsers };
