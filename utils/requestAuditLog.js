'use strict';

/**
 * Resolves a tenant audit logger for an arbitrary HTTP request, and guarantees the
 * act of logging cannot fail that request.
 *
 * WHY THE GUARD MATTERS HERE. utils/tenantAuditLog.js is deliberately UNGUARDED: a
 * full disk or an unwritable log directory throws, which turns an already-successful
 * request into a failure. That hazard is preserved on the ProcessRequest path because
 * its behaviour is contractual (guardrail G6, S-10 in CODE_QUALITY_RECOMMENDATIONS.md)
 * and characterization tests pin it.
 *
 * The newer logging built on top of this module - the access log and the FlightView
 * request/response records - has no such contract. It is observability added after
 * the migration, and it must never be the reason a route that used to work starts
 * returning 500. So every call here is wrapped, and a failure is downgraded to an
 * appLogger warning.
 *
 * Tenant resolution can also fail outright: ConfigReader THROWS for a host that
 * cannot be resolved - an unreadable or invalid config/tenants.jsonc. That is why this
 * returns null rather than a logger, and why callers must handle null.
 */

const tenantRegistry = require('../config/tenantRegistry');
const tenantAuditLog = require('./tenantAuditLog');
const { requestHost } = require('./requestUtils');
const appLogger = require('./appLogger');

/** Wraps a tenant logger so neither method can throw into the request pipeline. */
function toSafeLogger(inner) {
  return {
    lineBreak: inner.lineBreak,
    log(text) {
      try {
        inner.log(text);
      } catch (error) {
        appLogger.warn('Audit log write failed', { message: error && error.message });
      }
    },
    logException(error, req) {
      try {
        inner.logException(error, req);
      } catch (loggingError) {
        appLogger.warn('Audit exception write failed', { message: loggingError && loggingError.message });
      }
    }
  };
}

/**
 * @param {import('express').Request} req
 * @returns {{lineBreak: string, log: Function, logException: Function}|null}
 *   null when the request's host matches no tenant, so callers must null-check.
 */
function tryCreateRequestLogger(req) {
  try {
    return toSafeLogger(tenantAuditLog.createTenantLogger(tenantRegistry.defaultTenant()));
  } catch (error) {
    // An unknown tenant is expected for stray traffic; do not escalate it.
    appLogger.warn('Audit logging unavailable for request', {
      host: requestHost(req),
      message: error && error.message
    });
    return null;
  }
}

module.exports = { tryCreateRequestLogger };
