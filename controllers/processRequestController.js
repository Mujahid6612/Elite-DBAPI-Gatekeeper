'use strict';

const { createConfigReader } = require('../config/configReaderProvider');
const processRequestService = require('../services/processRequestService');
const { getClientIp, requestHost } = require('../utils/requestUtils');
const { sendWebApiString } = require('../utils/webApiCompat');
const { clientSafeMessage, isRedacted } = require('../utils/clientSafeError');
const appLogger = require('../utils/appLogger');

/** GET /DBAPI/ProcessRequest — health-style welcome endpoint. */
function getWelcome(req, res) {
  res.status(200).json(['Welcome to DB API']);
}

/**
 * GET /DBAPI/ProcessRequest/:id — diagnostic endpoint. No try/catch here by
 * design: the source action has no catch either, so config/IP/decryption
 * failures propagate to the framework's 500 handler.
 */
function getDiagnostic(req, res) {
  const host = requestHost(req);
  const clientIP = getClientIp(req);
  const summary = processRequestService.getDiagnosticSummary(host, clientIP);
  return sendWebApiString(req, res, summary);
}

/**
 * Handles a failure raised after the happy path started.
 *
 * Two preserved quirks live here, both deliberate:
 *  1. The error message is returned as a NORMAL action result, so the caller receives
 *     HTTP 200 with the exception text as the body - not a 4xx/5xx. Clients depend on
 *     the status, so this must not become a 4xx/5xx.
 *  2. `config` may still be null if tenant construction itself failed. The logging
 *     call below dereferences it anyway, exactly as the source did, which converts
 *     that case into a framework 500. Do NOT add a null guard.
 *
 * CHANGED: the BODY is now filtered through utils/clientSafeError.js. The status code,
 * the response shape and every deliberate message (access denied, invalid credentials,
 * missing member, JSON syntax) are untouched; only unexpected INFRASTRUCTURE text -
 * `ORA-` errors naming the schema, package and line of the failing procedure, driver
 * and filesystem errors - is replaced with the generic string. Those were previously
 * echoed verbatim to a caller that, given `whitelistedIPs=*`, could be anyone.
 *
 * The original message is still recorded in full: logProcessRequestFailure writes it
 * to the tenant audit log, and a redacted one is additionally sent to the application
 * log so an operator can correlate what the caller saw with what actually happened.
 *
 * Only a failure of the logging step itself is forwarded to the error middleware.
 */
function respondWithHandledFailure(req, res, next, error, config, jsonRequest) {
  try {
    processRequestService.logProcessRequestFailure(error, config, jsonRequest, req);

    if (isRedacted(error)) {
      appLogger.error('ProcessRequest failed; detail withheld from the caller', {
        message: error && error.message,
        name: error && error.name,
        stack: error && error.stack,
        path: req && (req.originalUrl || req.url)
      });
    }

    return sendWebApiString(req, res, clientSafeMessage(error));
  } catch (loggingFailure) {
    return next(loggingFailure);
  }
}

/** POST /DBAPI/ProcessRequest — the core stored-procedure dispatch endpoint. */
async function postProcessRequest(req, res, next) {
  // Decoded by middleware/fromBodyString on this route.
  const jsonRequest = req.jsonRequest;

  // Declared outside the try so it stays populated for the failure path as soon as
  // tenant resolution succeeds, matching the source app's control flow exactly.
  let config = null;

  try {
    config = createConfigReader(requestHost(req));
    const observedClientIP = getClientIp(req);
    const response = await processRequestService.handleProcessRequest(config, jsonRequest, observedClientIP);
    return sendWebApiString(req, res, response);
  } catch (error) {
    return respondWithHandledFailure(req, res, next, error, config, jsonRequest);
  }
}

module.exports = { getWelcome, getDiagnostic, postProcessRequest };
