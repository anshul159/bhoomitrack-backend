// The API's only recurring job (v2): the owner's daily summary.
//
// There was no scheduler at all before this (constraint 7 in the architecture
// review). This is deliberately the smallest one that is safe: a timer inside the
// API process that asks "is anyone due?" every few minutes. It needs no new
// service on Render and no new credentials, and it is safe to run on more than
// one instance, because sendDailySummaries claims each owner's day in the
// database before sending.
//
// Started only when server.js runs as the real server, never under tests.

const { sendDailySummaries } = require('./dailySummary');
const { captureError } = require('./observability');

const EVERY_MS = 5 * 60 * 1000;      // a summary arrives within 5 minutes of the chosen hour
const FIRST_RUN_MS = 60 * 1000;      // and soon after a deploy, if one was due during it

/** @returns {() => void} stops the scheduler */
function startScheduler({ everyMs = EVERY_MS, firstRunMs = FIRST_RUN_MS } = {}) {
  if (process.env.DISABLE_SCHEDULER === '1') {
    console.log('[SCHEDULER] Disabled by DISABLE_SCHEDULER=1.');
    return () => {};
  }

  let running = false;
  const tick = async () => {
    if (running) return;              // a slow run is never overlapped by the next
    running = true;
    try {
      const { sent, day } = await sendDailySummaries();
      if (sent > 0) console.log(`[SCHEDULER] Daily summary sent to ${sent} owner(s) for ${day}.`);
    } catch (err) {
      console.error('[SCHEDULER] Daily summary run failed:', err.message);
      captureError(err, { kind: 'scheduler', job: 'dailySummary' });
    } finally {
      running = false;
    }
  };

  // unref: a pending tick must never be the thing keeping the process alive.
  const first = setTimeout(tick, firstRunMs);
  first.unref();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  const every = everyMs >= 60000 ? `${Math.round(everyMs / 60000)} min` : `${Math.round(everyMs / 1000)} s`;
  console.log(`[SCHEDULER] Daily summaries checked every ${every}.`);
  return () => { clearTimeout(first); clearInterval(timer); };
}

module.exports = { startScheduler };
