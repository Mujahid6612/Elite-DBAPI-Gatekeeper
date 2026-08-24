'use strict';

const flightViewService = require('../services/flightViewService');
const { sendWebApiString } = require('../utils/webApiCompat');
const { tryCreateRequestLogger } = require('../utils/requestAuditLog');

/**
 * GET /DBAPI/FlightView — proxies and optionally converts the upstream XML feed.
 *
 * Audit logging added here because this route previously recorded NOTHING: the
 * tenant content log covers only POST /DBAPI/ProcessRequest, so a FlightView
 * failure left no trace beyond a bare 500. The upstream URL is logged because it is
 * the first thing needed to diagnose one - it shows exactly what was asked of
 * FlightView, including how the caller's query parameters were mapped.
 *
 * The logger is null-checked rather than assumed: tryCreateRequestLogger returns
 * null when the request host matches no tenant in config.xml.
 */
async function getFlightView(req, res, next) {
  const audit = tryCreateRequestLogger(req);

  try {
    const upstreamUrl = flightViewService.buildUpstreamUrl(req.query);
    if (audit) audit.log(`FLIGHTVIEW-REQUEST:${audit.lineBreak}${upstreamUrl}`);

    const response = await flightViewService.fetchFlightView(req.query);

    if (audit) audit.log(`FLIGHTVIEW-RESPONSE:${audit.lineBreak}${response}`);

    return sendWebApiString(req, res, response);
  } catch (error) {
    // Replaces a stray `console.log(2, error)` that wrote an unlabelled value to
    // stdout and was never captured anywhere durable.
    if (audit) audit.logException(error, req);

    // The source controller has no catch, so failures must surface as a real 500.
    // Express 5 already auto-forwards rejected promises from async handlers, making
    // this wrapper redundant today; it is kept explicit so the intent is visible and
    // so behavior survives a downgrade. Do not copy it to non-async handlers.
    return next(error);
  }
}

/** GET /DBAPI/FlightView/:id — stub, matches the source's literal 'value' response. */
function getFlightViewById(req, res) {
  return sendWebApiString(req, res, 'value');
}

/** POST/PUT/DELETE /DBAPI/FlightView — source `void` actions map to 204 No Content. */
function noContent(req, res) {
  res.status(204).end();
}

module.exports = { getFlightView, getFlightViewById, noContent };
