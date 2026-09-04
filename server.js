require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const compression = require('compression');

const { initSentry, attachErrorHandler, captureError } = require('./utils/observability');
const { requireMinAppVersion, config: versionConfig } = require('./middleware/appVersion');

// ─── FAIL FAST ON MISSING SECRETS ─────────────────────────────────────────────
if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI not set in environment variables');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error('❌ JWT_SECRET not set in environment variables. Refusing to start with an insecure default.');
  process.exit(1);
}

// Reported by /healthz. Read from package.json rather than restated here, because
// a hardcoded string is a fact that goes stale silently — this one still said
// '1.2.0' several releases after it stopped being true.
const APP_VERSION = require('./package.json').version;
const HEALTHZ_PING_TIMEOUT_MS = Number(process.env.HEALTHZ_PING_TIMEOUT_MS || 2000);

const app = express();

// Render/other PaaS sit behind a reverse proxy — needed for correct client IPs (rate limiting)
app.set('trust proxy', 1);

// Error tracking, if SENTRY_DSN is configured (ENH-004).
initSentry(app);

// ─── SECURITY MIDDLEWARE ──────────────────────────────────────────────────────
app.use(helmet());

// Response compression (PF-005).
//
// Measured before this was added: GET /slips/pending?limit=500 was 437.8 KB on the
// wire and 51.0 KB gzipped — 9.0s versus 1.0s on a 400 kbps connection, which is an
// ordinary Indian mobile link and therefore the connection most of our users are on.
// No client change is needed; the app already sends Accept-Encoding: gzip.
app.use(compression());

// CORS allow-list (ENH-019).
//
// The default `cors()` accepted any origin. Impact was low while the only client
// was a native app — CORS does not apply there — but it had to be closed before a
// web client or admin console exists. Requests with no Origin header (the Android
// app, curl, health checks) are still allowed; browsers are held to the list.
const allowedOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);            // non-browser client
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(mongoSanitize()); // strips $ and . from keys to block NoSQL injection

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
//
// Two findings shaped what follows.
//
// PF-004: every limiter keyed on IP. That is right for a manager on their own
// mobile connection and wrong for a site office, where several people share one
// public IP and therefore one budget — most painfully on the credential limiter,
// where 25 attempts per 15 minutes was the whole office's allowance. A few mistyped
// passwords consumed it, and it presented as "too many attempts" to somebody who
// had tried once.
//
// PF-006: the limiter bounded volume, not rate. 600 requests were permitted in any
// distribution across 15 minutes, including all 600 in two seconds. That is exactly
// the 07:00 shift-start shape, and what push notifications produce once enabled — a
// notification to every owner creates a synchronised wave of app opens.
//
// The answer to PF-006 is a short-window limiter *alongside* the volume cap, not a
// lower cap. A lower cap would punish the legitimate burst as well as the abusive one.

const jwt = require('jsonwebtoken');

// express-rate-limit v7 requires IPv6 addresses to be normalised before use as a
// key, or a /64 client can trivially rotate addresses to get fresh buckets.
const ipKey = rateLimit.ipKeyGenerator
  ? (req) => rateLimit.ipKeyGenerator(req.ip)
  : (req) => req.ip;

// Identify the caller, preferring the authenticated user over the connection.
//
// The token is *verified*, not merely decoded. Decoding alone would let an attacker
// mint arbitrary subjects and give themselves an unlimited supply of fresh buckets,
// which is the whole protection gone. Verification is an HMAC check with no database
// round trip, so this costs nothing meaningful.
function callerKey(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
      const sub = payload.id || payload.userId || payload.sub;
      if (sub) return `user:${sub}`;
    } catch {
      // Invalid or expired token — fall through to the connection key.
    }
  }
  return `ip:${ipKey(req)}`;
}

// General API limiter — generous, protects against abuse/DoS. Keyed per user where
// there is one, so an office on a single IP no longer shares one budget (PF-004).
//
// The four limits below are env-tunable so a test can pin one down to a value it can
// actually reach in a few requests. They are NOT disabled under test: a limiter that
// is switched off in the only environment that runs assertions is a limiter nobody
// has ever checked.
const LIMITS = {
  apiMax:    Number(process.env.RATE_LIMIT_API_MAX    || 600),
  burstMax:  Number(process.env.RATE_LIMIT_BURST_MAX  || 60),
  authMax:   Number(process.env.RATE_LIMIT_AUTH_MAX   || 25),
  sprayMax:  Number(process.env.RATE_LIMIT_SPRAY_MAX  || 200),
};

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: LIMITS.apiMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: callerKey,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});

// Burst limiter (PF-006). Sits alongside the volume cap rather than replacing it:
// 60 requests in 10 seconds is far above any real screen's needs — the busiest
// dashboard load is a handful of calls — while still refusing a runaway retry loop
// or a scripted flood.
const burstLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: LIMITS.burstMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: callerKey,
  message: { success: false, message: 'Too many requests at once. Please retry in a moment.' },
});

// Strict limiter for credential/OTP endpoints — blocks brute force.
//
// Keyed on the connection *and* the identity being attempted (PF-004), so twelve
// people in one office each get their own allowance while an attacker working
// through passwords for one account is still stopped at 25.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: LIMITS.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const identity = String(
      req.body?.email || req.body?.phone || req.body?.code || ''
    ).toLowerCase().trim();
    return `${ipKey(req)}|${identity}`;
  },
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' },
});

// A second, looser credential limiter keyed on the connection alone. Without this,
// keying by identity would let one host spray one attempt each at thousands of
// accounts and never trip a limit.
const authSprayLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: LIMITS.sprayMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: { success: false, message: 'Too many attempts from this connection. Please try again later.' },
});

app.use('/api', burstLimiter);
app.use('/api', apiLimiter);

// Credential endpoints, under both the legacy and versioned prefixes.
const AUTH_PATHS = [
  '/users/login',
  '/users/web-login',
  '/users/manager-login',
  '/users/forgot-password',
  '/users/reset-password',
  '/users/change-password',
  '/users/setup-super-admin',
  '/users/register-company',
  '/invite/verify',
  '/invite/register',
];
const AUTH_ROUTES = AUTH_PATHS.flatMap(p => [`/api${p}`, `/api/v1${p}`]);
app.use(AUTH_ROUTES, authSprayLimiter);
app.use(AUTH_ROUTES, authLimiter);

// Force-update gate (ENH-010) — applies to everything under /api.
app.use('/api', requireMinAppVersion);

// ─── ROUTES ───────────────────────────────────────────────────────────────────
const auth = require('./middleware/auth');
const requireOrgId = require('./middleware/requireOrgId');
const requireActiveOrg = require('./middleware/requireActiveOrg');

// orgGuard = valid JWT + belongs to an org (data isolation) + the organisation's
// subscription is live (ENH-003).
const orgGuard = [auth, requireOrgId, requireActiveOrg];

// Mounted at both the legacy prefix and an explicit version (ENH-010). `/api`
// stays permanently as an alias for v1 — thousands of installed apps call it, and
// a version segment is only useful if adding v2 does not break them.
function mountRoutes(base) {
  app.use(`${base}/users`,     require('./routes/users'));
  app.use(`${base}/invite`,    require('./routes/invite'));

  // Billing and export sit outside the subscription gate on purpose: a lapsed
  // customer must still be able to see what they owe and export their data.
  app.use(`${base}/org`,       auth, requireOrgId, require('./routes/org'));

  // All data routes require a JWT, an orgId, and an active subscription.
  app.use(`${base}/sites`,     ...orgGuard, require('./routes/sites'));
  app.use(`${base}/inventory`, ...orgGuard, require('./routes/inventory'));
  app.use(`${base}/orders`,    ...orgGuard, require('./routes/orders'));
  app.use(`${base}/slips`,     ...orgGuard, require('./routes/slips'));
  app.use(`${base}/chat`,      ...orgGuard, require('./routes/chat'));
  app.use(`${base}/reports`,   ...orgGuard, require('./routes/reports'));
  app.use(`${base}/audit`,     ...orgGuard, require('./routes/audit'));
}

mountRoutes('/api/v1');
mountRoutes('/api');

// ─── VERSION / UPDATE CHECK ───────────────────────────────────────────────────
// The app calls this on launch to find out whether it must update (ENH-010).
app.get(['/api/version', '/api/v1/version'], (req, res) => {
  const { min, latest, storeUrl } = versionConfig();
  res.json({
    success: true,
    api_version: 'v1',
    min_app_version: min,
    latest_app_version: latest,
    store_url: storeUrl,
  });
});

// ─── HEALTH CHECKS ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ success: true, message: 'BhoomiTrack API is running ✅', version: APP_VERSION });
});

// For an external uptime monitor (ENH-004). Reports the database connection, not
// merely that the process is listening: an API that cannot reach MongoDB is down
// as far as a customer is concerned, and a check that passes anyway is worse than
// no check at all.
app.get('/healthz', async (req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const state = mongoose.connection.readyState;

  // readyState is a socket flag, not a liveness probe (PF-008). A frozen mongod
  // holds the socket open, so readyState stays 1 while every real query hangs —
  // which is exactly the outage this check exists to catch, and exactly the one
  // it used to report as healthy. Actually ask the server something, and bound
  // the wait so a hung database fails the check rather than hanging it too.
  let healthy = state === 1;
  let database = states[state] || 'unknown';

  if (healthy) {
    try {
      let timer;
      await Promise.race([
        mongoose.connection.db.admin().ping(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('ping timed out')), HEALTHZ_PING_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
    } catch (err) {
      healthy = false;
      database = 'unresponsive';
    }
  }

  res.status(healthy ? 200 : 503).json({
    success: healthy,
    status: healthy ? 'ok' : 'degraded',
    database,
    uptime_seconds: Math.round(process.uptime()),
    version: APP_VERSION,
  });
});

// ─── 404 + GLOBAL ERROR HANDLER ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

attachErrorHandler(app);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[UNHANDLED ERROR]', err);
  captureError(err, { path: req?.originalUrl, method: req?.method });
  if (res.headersSent) return;
  if (err?.message === 'Not allowed by CORS') {
    return res.status(403).json({ success: false, message: 'Origin not allowed' });
  }
  res.status(err.status || 500).json({ success: false, message: 'Server error' });
});

// ─── DATABASE + SERVER START ──────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

// Exported unstarted so the test suite can drive the app without binding a port
// or needing a real database.
module.exports = app;

if (require.main === module) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => {
      console.log('✅ Connected to MongoDB');
      app.listen(PORT, () => console.log(`🚀 BhoomiTrack server running on port ${PORT}`));
    })
    .catch(err => {
      console.error('❌ MongoDB connection failed:', err.message);
      process.exit(1);
    });
}

// Don't crash the whole process on stray async errors — log and report them
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
  captureError(reason instanceof Error ? reason : new Error(String(reason)), { kind: 'unhandledRejection' });
});
