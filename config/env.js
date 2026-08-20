'use strict';

const path = require('path');

// dotenv is resolved separately from being invoked, so that a genuinely absent
// package (which lets the dependency-free parity tests run before `npm install`)
// is distinguishable from dotenv itself failing to load. Previously both produced
// MODULE_NOT_FOUND and were swallowed identically, so a broken install started the
// process with no .env loaded at all and no indication why.
let dotenvAvailable = true;
try {
  require.resolve('dotenv');
} catch {
  dotenvAvailable = false;
  console.warn(
    '[config] dotenv is not installed; reading configuration from the process environment only. ' +
      'Run `npm install` if this is not a dependency-free test run.'
  );
}

if (dotenvAvailable) {
  // Deliberately unguarded: a real failure inside dotenv must surface, not be
  // mistaken for the package being missing.
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

/** @param {string|undefined} value @param {boolean} fallback @returns {boolean} */
function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return ['1', 'true', 'y', 'yes'].includes(String(value).trim().toLowerCase());
}

/**
 * Parses an optional integer setting. Returns `undefined` when the variable is unset
 * or blank, so callers can omit the key entirely rather than guessing a default -
 * this is how the Oracle pool settings stay at node-oracledb's own defaults until an
 * operator explicitly opts in. Returns NaN for a malformed value, which validateEnv
 * reports at startup.
 */
function optionalInt(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  return Number.parseInt(String(value), 10);
}

/** Drops keys whose value is undefined, leaving only explicitly configured settings. */
function definedOnly(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/**
 * @typedef {object} EnvConfig
 * @property {number} port
 * @property {string} flightViewUrl
 * @property {'webapi'|'raw'} stringResponseMode
 * @property {string} bodyLimit
 * @property {boolean} trustProxy
 * @property {boolean} exposeErrors
 * @property {string} oracleUser
 * @property {string} oraclePassword
 * @property {string} oracleConnectString
 * @property {string} oracleConfigDir
 * @property {boolean} oracleThickMode
 * @property {string} oracleClientLibDir
 * @property {Record<string, number>} oraclePool
 * @property {number} shutdownTimeoutMs
 * @property {'stderr'|'stdout'} eventLogFallback
 * @property {'silent'|'error'|'warn'|'info'|'debug'} logLevel
 * @property {string} projectRoot
 */

/** @type {EnvConfig} */
const envConfig = Object.freeze({
  port: Number.parseInt(process.env.PORT || '5000', 10),
  flightViewUrl: process.env.FLIGHTVIEW_URL || 'http://xml.flightview.com/fvEliteLimoPlus/fvxml.exe?',
  stringResponseMode: (process.env.STRING_RESPONSE_MODE || 'webapi').trim().toLowerCase(),
  // Maximum accepted request body size. This is the primary limit on how much data a
  // single caller can push at the service, so it is the main denial-of-service control.
  bodyLimit: (process.env.BODY_LIMIT || '2mb').trim(),
  trustProxy: toBoolean(process.env.TRUST_PROXY, false),
  exposeErrors: toBoolean(process.env.EXPOSE_ERRORS, false),
  // Oracle pool credentials. Note these are process-wide: every tenant shares one
  // database identity regardless of its config.xml targetDBConnectionString. That is
  // pre-existing behavior, flagged in REFACTOR_NOTES.md, and not changed here.
  oracleUser: process.env.ORACLE_USER || '',
  oraclePassword: process.env.ORACLE_PASSWORD || '',
  oracleConnectString: process.env.ORACLE_CONNECTION || '',
  oracleConfigDir: process.env.ORACLE_CONFIG_DIR || process.env.TNS_ADMIN || '',
  oracleThickMode: toBoolean(process.env.ORACLE_THICK_MODE, false),
  // Thick-mode client libraries, not tnsnames.ora. Deliberately does NOT fall back to
  // TNS_ADMIN: an Oracle Instant Client directory and a network-config directory are
  // different things, and conflating them points initOracleClient() at the wrong path.
  oracleClientLibDir: process.env.ORACLE_CLIENT_LIB_DIR || '',
  /**
   * Oracle pool tuning. Only keys the operator actually set are present, so an
   * unset variable means "leave node-oracledb's default alone" rather than pinning
   * a value we guessed. Unset overall (the default) reproduces prior behavior
   * exactly, including the driver's implicit poolMax of 4 - which is the current
   * ceiling on concurrent database work.
   */
  oraclePool: Object.freeze(
    definedOnly({
      poolMin: optionalInt(process.env.ORACLE_POOL_MIN),
      poolMax: optionalInt(process.env.ORACLE_POOL_MAX),
      poolIncrement: optionalInt(process.env.ORACLE_POOL_INCREMENT),
      poolTimeout: optionalInt(process.env.ORACLE_POOL_TIMEOUT),
      queueTimeout: optionalInt(process.env.ORACLE_QUEUE_TIMEOUT),
      stmtCacheSize: optionalInt(process.env.ORACLE_STMT_CACHE_SIZE)
    })
  ),
  // How long a graceful shutdown may take before the process is forced to exit.
  shutdownTimeoutMs: optionalInt(process.env.SHUTDOWN_TIMEOUT_MS) ?? 15000,
  eventLogFallback: (process.env.EVENT_LOG_FALLBACK || 'stderr').trim().toLowerCase(),
  // Threshold for the application logger (utils/appLogger.js). Does not affect the
  // per-tenant audit log, whose output is contractual.
  logLevel: (process.env.LOG_LEVEL || 'info').trim().toLowerCase(),
  projectRoot: path.resolve(__dirname, '..')
});

module.exports = envConfig;
