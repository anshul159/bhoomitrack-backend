// Error tracking and uptime surface (ENH-004).
//
// Unhandled errors used to go to the Render console and nowhere else, and nothing
// watched whether the API was up — so a customer knew the product was broken
// before the founder did.
//
// Sentry is initialised only when SENTRY_DSN is set, so local development and
// tests are unaffected and the server still boots if the package is missing. The
// uptime side is `/healthz`, which an external checker (UptimeRobot, Better Stack,
// Render's own) polls; it reports the database connection, not merely that the
// process is listening, because a server that cannot reach MongoDB is down as far
// as a customer is concerned.

let Sentry = null;

function initSentry(app) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.warn('[OBS] SENTRY_DSN not set — error tracking disabled.');
    return null;
  }
  try {
    // Required lazily so a missing dependency degrades to "no tracking" rather
    // than refusing to start the API.
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      release: process.env.RENDER_GIT_COMMIT || undefined,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
      // Never let an error report carry a credential or a reset code off-site.
      beforeSend(event) {
        if (event.request?.data) {
          const data = event.request.data;
          for (const key of ['password', 'newPassword', 'token', 'setupKey', 'code']) {
            if (key in data) data[key] = '[redacted]';
          }
        }
        return event;
      },
    });
    console.log('[OBS] Sentry initialized.');
    return Sentry;
  } catch (err) {
    console.error('[OBS] Sentry failed to initialize — continuing without it.', err.message);
    Sentry = null;
    return null;
  }
}

// Reports an error that has already been handled, so it is visible even though
// the request itself succeeded or failed gracefully.
function captureError(err, context = {}) {
  if (!Sentry) return;
  try {
    Sentry.withScope((scope) => {
      for (const [k, v] of Object.entries(context)) scope.setExtra(k, v);
      Sentry.captureException(err);
    });
  } catch (_) { /* reporting must never throw */ }
}

function attachErrorHandler(app) {
  if (!Sentry) return;
  try {
    if (typeof Sentry.setupExpressErrorHandler === 'function') {
      Sentry.setupExpressErrorHandler(app); // @sentry/node v8+
    } else if (Sentry.Handlers?.errorHandler) {
      app.use(Sentry.Handlers.errorHandler()); // v7 and earlier
    }
  } catch (err) {
    console.error('[OBS] Could not attach Sentry error handler:', err.message);
  }
}

module.exports = { initSentry, captureError, attachErrorHandler };
