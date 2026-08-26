// API versioning and the force-update path (ENH-010).
//
// Once the app is on customers' phones you no longer control which build is
// calling. A breaking change breaks every phone that has not updated, and there
// is no way to make them update — unless the API can say so.
//
// The app sends its build via `X-App-Version` (an integer versionCode). Anything
// below the configured minimum gets 426 Upgrade Required, which the app turns
// into a blocking update screen. Requests without the header are let through:
// existing builds do not send it, and locking them out on deploy day is exactly
// the outage this exists to prevent.
//
// Settings are read per request rather than captured at import, so raising the
// floor during an incident takes effect on the next request rather than needing
// a code change.

function config() {
  return {
    min: Number(process.env.MIN_APP_VERSION || 0),
    latest: Number(process.env.LATEST_APP_VERSION || 0),
    storeUrl: process.env.STORE_URL || 'https://play.google.com/store/apps/details?id=com.bhoomitrack',
  };
}

function requireMinAppVersion(req, res, next) {
  const raw = req.headers['x-app-version'];
  if (raw === undefined) return next();

  const version = Number(raw);
  if (!Number.isFinite(version)) return next();

  const { min, latest, storeUrl } = config();
  if (min > 0 && version < min) {
    return res.status(426).json({
      success: false,
      code: 'update_required',
      message: 'This version of BhoomiTrack is no longer supported. Please update to continue.',
      min_version: min,
      latest_version: latest,
      store_url: storeUrl,
    });
  }
  return next();
}

module.exports = { requireMinAppVersion, config };
