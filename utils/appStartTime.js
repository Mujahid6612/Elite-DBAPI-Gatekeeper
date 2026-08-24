'use strict';

/**
 * Process start time and uptime, derived from `process.uptime()`.
 *
 * WHY NOT A FILE. This previously wrote `appHealthLogs/app-start.json` at boot and
 * read it back. That could not work on the deployed service, for two independent
 * reasons:
 *
 *  1. The write happened in server.js, which NEVER RUNS on a serverless host - the
 *     entrypoint there is api/index.js, which requires app.js directly. So the file
 *     was never created and startedAt/uptime were always null.
 *  2. Even when reached, the target resolved to `<projectRoot>/appHealthLogs`, and a
 *     serverless filesystem is read-only outside the temp directory, so mkdirSync
 *     would have thrown EROFS.
 *
 * `process.uptime()` is a Node builtin that needs no startup hook, no filesystem and
 * no module-load timing assumption, so it is correct under `node server.js` and
 * inside a function instance alike.
 *
 * WHAT IT MEASURES. The lifetime of THIS PROCESS. On a conventional always-on server
 * that is the application's uptime. On a serverless host it is the age of the
 * individual instance that happened to serve the request - often seconds, and
 * different from one request to the next, because each cold start is a new process.
 * It is a useful signal (it reveals cold starts) but it is NOT a measure of how long
 * the service has been available, and must not be read as one.
 */

/**
 * @returns {{startedAt: string, pid: number}} Always a value - unlike the previous
 *   file-backed implementation, this cannot return null, so callers no longer have a
 *   "missing" case to handle.
 */
function getApplicationStartTime() {
  return {
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    pid: process.pid
  };
}

/**
 * Breaks an elapsed period into days/hours/minutes/seconds.
 * @param {string} startedAt ISO timestamp
 */
function getUptimeDuration(startedAt) {
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) return null;

  let totalSeconds = Math.floor((Date.now() - start.getTime()) / 1000);
  if (totalSeconds < 0) totalSeconds = 0;

  const days = Math.floor(totalSeconds / 86400);
  totalSeconds %= 86400;
  const hours = Math.floor(totalSeconds / 3600);
  totalSeconds %= 3600;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return { days, hours, minutes, seconds };
}

function formatUptime(uptime) {
  if (!uptime) return null;
  return (
    `${uptime.days} days, ${uptime.hours} hours, ` +
    `${uptime.minutes} minutes, ${uptime.seconds} seconds`
  );
}

/**
 * Records the start time in the application log.
 *
 * Retained because server.js calls it, but it no longer writes a file: the start
 * time is now derived on demand from process.uptime(), so persisting it served no
 * purpose and only added a filesystem dependency that fails on a read-only host.
 */
function saveApplicationStartTime() {
  const { startedAt } = getApplicationStartTime();
  console.log(`Application started at: ${startedAt}`);
}

module.exports = {
  saveApplicationStartTime,
  getApplicationStartTime,
  getUptimeDuration,
  formatUptime
};
