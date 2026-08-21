'use strict';

const flightViewService = require('../services/flightViewService');
const { sendWebApiString } = require('../utils/webApiCompat');

/** GET /DBAPI/FlightView — proxies and optionally converts the upstream XML feed. */
async function getFlightView(req, res, next) {
  try {
    const response = await flightViewService.fetchFlightView(req.query);

    return sendWebApiString(req, res, response);
  } catch (error) {
    console.log(2, error);

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
