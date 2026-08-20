'use strict';

const flightViewService = require('../services/flightViewService');
const { sendWebApiString } = require('../utils/webApiCompat');

/** GET /DBAPI/FlightView — proxies and optionally converts the upstream XML feed. */
async function getFlightView(req, res, next) {
  try {
    const response = await flightViewService.fetchFlightView(req.query);
    return sendWebApiString(req, res, response);
  } catch (error) {
    // The source controller has no catch; let the framework return a real 500.
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
