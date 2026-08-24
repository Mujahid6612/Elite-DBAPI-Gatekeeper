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

/**
 * Resolves a possibly-relative path setting against the project root, preserving ''
 * for an unset value so callers can still test it for emptiness.
 */
function resolveFromRoot(value) {
  const trimmed = String(value || '').trim();
  if (trimmed === '') return '';
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(__dirname, '..', trimmed);
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
  // A RELATIVE value is resolved against the project root, so a bundled client can be
  // referenced as `vendor/oracle` without knowing the absolute deployment path
  // (Vercel unpacks to /var/task, but that is an implementation detail of the
  // platform, not something a configuration value should have to encode).
  // An absolute path is used unchanged, which is how existing deployments set it.
  oracleClientLibDir: resolveFromRoot(process.env.ORACLE_CLIENT_LIB_DIR),
  // Literal TEXT of a tnsnames.ora, not a path. When set, repositories/oracleRepository.js
  // writes it under the OS temp directory and points configDir there. This exists because
  // `.gitignore` excludes `*.ora` and `tns/`, so a deployment built from the repository
  // has no tnsnames.ora and cannot resolve a TNS alias. Leave blank to use a real
  // ORACLE_CONFIG_DIR/TNS_ADMIN directory, or put the full connect descriptor straight
  // into ORACLE_CONNECTION and skip tnsnames.ora entirely.
  oracleTnsNames: process.env.ORACLE_TNSNAMES || '',
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
  // Mirror every tenant audit entry to stdout as well as to its file. Defaults ON:
  // on a serverless host the file lives in an ephemeral per-instance temp directory
  // that nobody can read, so stdout is the only sink that actually reaches an
  // operator. The file is still written either way - this is purely additive.
  auditLogStdout: toBoolean(process.env.AUDIT_LOG_STDOUT, true),
  // Threshold for the application logger (utils/appLogger.js). Does not affect the
  // per-tenant audit log, whose output is contractual.
  logLevel: (process.env.LOG_LEVEL || 'info').trim().toLowerCase(),
  projectRoot: path.resolve(__dirname, '..'),
  /**
   * Base directory for RELATIVE tenant logPath values (config.xml uses `~/Log`).
   * Defaults to projectRoot, which is the historical behavior.
   *
   * Needed because a serverless filesystem is read-only apart from the temp
   * directory, and the tenant audit log is NOT optional: services/processRequestService.js
   * writes the `1:` and `2:` markers on every POST regardless of enableLogging, and
   * utils/tenantAuditLog.js is deliberately unguarded, so an EROFS there turns a
   * request whose database call already SUCCEEDED into a failure. Setting
   * LOG_ROOT=/tmp moves the writes somewhere writable without altering the file
   * layout or contents. An absolute tenant logPath still wins over this.
   *
   * Note the temp directory is per-instance and ephemeral: logs written there are
   * for debugging a live instance, not durable audit retention.
   */
  logRoot: process.env.LOG_ROOT || path.resolve(__dirname, '..')
});

module.exports = envConfig;
