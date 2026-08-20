'use strict';

const path = require('path');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (error) {
  // Allows dependency-free parity tests to run before `npm install`.
  // Production startup still installs dotenv via package.json.
  if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
}

/** @param {string|undefined} value @param {boolean} fallback @returns {boolean} */
function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return ['1', 'true', 'y', 'yes'].includes(String(value).trim().toLowerCase());
}

/**
 * @typedef {object} EnvConfig
 * @property {number} port
 * @property {string} host
 * @property {string} flightViewUrl
 * @property {'webapi'|'raw'} stringResponseMode
 * @property {boolean} trustProxy
 * @property {boolean} exposeErrors
 * @property {string} oracleConfigDir
 * @property {boolean} oracleThickMode
 * @property {string} oracleClientLibDir
 * @property {'stderr'|'stdout'} eventLogFallback
 * @property {string} projectRoot
 */

/** @type {EnvConfig} */
const envConfig = Object.freeze({
  port: Number.parseInt(process.env.PORT || '5000', 10),
  host: process.env.HOST || '0.0.0.0',
  flightViewUrl: process.env.FLIGHTVIEW_URL || 'http://xml.flightview.com/fvEliteLimoPlus/fvxml.exe?',
  stringResponseMode: (process.env.STRING_RESPONSE_MODE || 'webapi').trim().toLowerCase(),
  trustProxy: toBoolean(process.env.TRUST_PROXY, false),
  exposeErrors: toBoolean(process.env.EXPOSE_ERRORS, false),
  oracleConfigDir: process.env.ORACLE_CONFIG_DIR || process.env.TNS_ADMIN || '',
  oracleThickMode: toBoolean(process.env.ORACLE_THICK_MODE, false),
  oracleClientLibDir: process.env.ORACLE_CLIENT_LIB_DIR ||process.env.TNS_ADMIN || '',
  eventLogFallback: (process.env.EVENT_LOG_FALLBACK || 'stderr').trim().toLowerCase(),
  projectRoot: path.resolve(__dirname, '..')
});

module.exports = envConfig;
