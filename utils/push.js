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

// Sends to one or more device tokens. Silently drops empty/invalid tokens and
// any token Firebase reports as no-longer-registered (uninstalled app, etc.) —
// callers don't need to know or care about delivery mechanics.
async function sendToTokens(tokens, title, body, data = {}) {
  const firebaseApp = getApp();
  const validTokens = (tokens || []).filter((t) => typeof t === 'string' && t.length > 0);
  if (!firebaseApp || validTokens.length === 0) return;

  try {
    await admin.messaging(firebaseApp).sendEachForMulticast({
      tokens: validTokens,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high' },
    });
  } catch (err) {
    console.error('[PUSH] Send failed:', err.message);
  }
}

// Looks up users by id, collects their fcmToken, and sends. `userDocsOrIds` can
// be either already-fetched user docs (with .fcmToken) or plain ids — pass docs
// when the caller already has them to avoid a redundant query.
async function sendToUsers(users, title, body, data = {}) {
  const tokens = users.map((u) => u.fcmToken).filter(Boolean);
  await sendToTokens(tokens, title, body, data);
}

module.exports = { sendToTokens, sendToUsers };
