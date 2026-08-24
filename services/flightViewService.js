'use strict';


const { XMLParser } = require('fast-xml-parser');
const envConfig = require('../config/env');
const { fixNullString } = require('../utils/nullHelpers');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: false
});

const FLIGHT_QUERY_FIELDS = ['ACID', 'DEPAP', 'DEPDATE', 'DEPHR', 'ARRAP', 'ARRDATE', 'ARRHR', 'AL', 'SIMPLESTATUS'];

/** Mirrors `AllKeys.Contains("KEY")` followed by `nvc["KEY"]`: exact key spelling gate. */
function queryValue(query, key) {
  if (!Object.prototype.hasOwnProperty.call(query, key)) return '';
  const value = query[key];
  return fixNullString(Array.isArray(value) ? value.join(',') : value);
}

function buildUpstreamQuery(query) {
  // Start with the parameter required by the FlightView endpoint.
  let param = '1=1';
  for (const field of FLIGHT_QUERY_FIELDS) {
    const value = queryValue(query, field);
    if (value !== '') param += `&${field}=${value}`;
  }
  return param;
}

/**
 * Fetches the upstream FlightView response, converting it to JSON only when
 * `RESP=JSON` is requested (preserving the raw XML by default).
 */

/**
 * The exact upstream URL a given query resolves to.
 *
 * Exported so the controller can record it in the audit log without duplicating the
 * parameter-building rules. Diagnosing a FlightView problem almost always starts
 * with "what did we actually ask upstream?", and previously nothing recorded it.
 */
function buildUpstreamUrl(query) {
  return envConfig.flightViewUrl + buildUpstreamQuery(query);
}

async function fetchFlightView(query) {
  const url = buildUpstreamUrl(query);

  const upstream = await fetch(url, {
    headers: { 'Accept-Encoding': 'identity' }
  });

  if (!upstream.ok) {
    throw new Error(`Response status code does not indicate success: ${upstream.status}.`);
  }

  const body = await upstream.text();
  const responseType = queryValue(query, 'RESP');
  if (responseType.toUpperCase() === 'JSON') {
    // Convert only when the caller explicitly requests JSON.
    return JSON.stringify(xmlParser.parse(body));
  }
  return body;
}

module.exports = { fetchFlightView, buildUpstreamUrl };
