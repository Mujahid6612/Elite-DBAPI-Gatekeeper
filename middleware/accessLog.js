'use strict';

/**
 * Writes one log line for every request that comes in.
 *
 * WHY IT EXISTS: Only the main endpoint used to record anything, so problems on any other route
 *                left no trace at all.
 *
 * ROLE IN THE FLOW: Wraps all routes. Records the status code, how long it took and the caller's
 *                   IP once the reply has been sent.
 */

/**
 * One audit entry per HTTP request, recording what the per-tenant content log does
 * not: the response STATUS CODE, the DURATION, the CLIENT IP and the request line.
 *
 * Coverage is the point. The ProcessRequest content log only covers
 * `POST /DBAPI/ProcessRequest`; every other route - the FlightView endpoints, the
 * welcome and diagnostic GETs, and 404s - previously produced no record at all.
 * Because this hooks the response rather than a controller, it covers all of them
 * uniformly, including requests that never reached a route.
 *
 * ADDITIVE ONLY. This emits a new `ACCESS:` entry and does not alter any existing
 * line, so parity guardrail G6 is untouched and existing log parsers keep working.
 *
 * Not gated on the tenant's `enableLogging`: that flag governs whether request and
 * response BODIES are recorded, which is a data-sensitivity decision. Status and
 * timing carry no payload and are what an operator needs to diagnose a live
 * incident, so they are controlled separately by AUDIT_ACCESS_LOG.
 */

const envConfig = require('../config/env');
const { tryCreateRequestLogger } = require('../utils/requestAuditLog');
const { getClientIp } = require('../utils/requestUtils');
const { redactSecrets } = require('../utils/logRedaction');

/** Nanoseconds to milliseconds, at 0.1ms resolution. */
function elapsedMs(startedAt) {
  return Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10;
}

function accessLog(req, res, next) {
  if (!envConfig.auditAccessLog) return next();

  // process.hrtime is monotonic; Date.now() can jump backwards on a clock
  // adjustment and yield a negative duration.
  const startedAt = process.hrtime.bigint();

  // 'finish' fires once the response has been flushed, which is the only point at
  // which the status code is final. It also fires for 404s and for error responses,
  // so those are captured too. Registered before next() so a route that responds
  // synchronously is still measured.
  res.on('finish', () => {
    const audit = tryCreateRequestLogger(req);
    if (!audit) return;

    // The URL is included with the query string because for the FlightView routes
    // the query IS the request payload. Redacted for the same reason bodies are:
    // nothing stops a caller putting a credential in a query parameter.
    const fields = [
      `method=${req.method}`,
      `path=${redactSecrets(req.originalUrl || req.url)}`,
      `status=${res.statusCode}`,
      `durationMs=${elapsedMs(startedAt)}`,
      `clientIP=${getClientIp(req) || ''}`
    ].join(' ');

    audit.log(`ACCESS:${audit.lineBreak}${fields}`);
  });

  next();
}

module.exports = accessLog;
