'use strict';

const ConfigReader = require('../config/tenantConfig');
const processRequestService = require('../services/processRequestService');
const { getClientIp, requestHost } = require('../utils/requestUtils');
const { unwrapFromBodyString, sendWebApiString } = require('../utils/webApiCompat');

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

/** POST /DBAPI/ProcessRequest — the core stored-procedure dispatch endpoint. */
async function postProcessRequest(req, res, next) {
  const jsonRequest = unwrapFromBodyString(req.body);
  // Declared here (not inside the try) so it stays populated for the catch
  // block below as soon as ConfigReader succeeds, even if a later step
  // throws — matching the source app's control flow exactly.
  let config = null;

  try {
    config = new ConfigReader(requestHost(req));
    const observedClientIP = getClientIp(req);
    const response = await processRequestService.handleProcessRequest(config, jsonRequest, observedClientIP);
    return sendWebApiString(req, res, response);
  } catch (error) {
    try {
      processRequestService.logProcessRequestFailure(error, config, jsonRequest, req);
      return sendWebApiString(req, res, error.message);
    } catch (loggingFailure) {
      return next(loggingFailure);
    }
  }
}

module.exports = { getWelcome, getDiagnostic, postProcessRequest };
