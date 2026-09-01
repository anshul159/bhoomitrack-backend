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

// General API limiter — generous, protects against abuse/DoS
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});

// Strict limiter for credential/OTP endpoints — blocks brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' },
});

app.use('/api', apiLimiter);

// Credential endpoints, under both the legacy and versioned prefixes.
const AUTH_PATHS = [
  '/users/login',
  '/users/manager-login',
  '/users/forgot-password',
  '/users/reset-password',
  '/users/change-password',
  '/users/setup-super-admin',
  '/users/register-company',
  '/invite/verify',
  '/invite/register',
];
app.use(AUTH_PATHS.flatMap(p => [`/api${p}`, `/api/v1${p}`]), authLimiter);

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
