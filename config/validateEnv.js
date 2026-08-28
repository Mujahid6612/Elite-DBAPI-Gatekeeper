'use strict';

/**
 * Checks the configuration at startup and refuses to start if anything is wrong.
 *
 * WHY IT EXISTS: A missing password should stop a deployment immediately, not fail one customer's
 *                request days later.
 *
 * ROLE IN THE FLOW: Runs once, before the server accepts any traffic. Reports every problem at
 *                   once rather than one per restart.
 */

const envConfig = require('./env');
const tenantRegistry = require('./tenantRegistry');
const appLogger = require('../utils/appLogger');

/**
 * Fail-fast configuration validation, run once at startup before any connection
 * is attempted.
 *
 * Without this, misconfiguration failed late and silently rather than loudly:
 * `PORT=abc` bound a random port, a misspelled STRING_RESPONSE_MODE quietly
 * changed the wire format, and absent Oracle credentials surfaced as a driver
 * error that named no environment variable.
 *
 * Every default in config/env.js is preserved - a correctly configured
 * deployment sees no change in behavior.
 */

const STRING_RESPONSE_MODES = ['webapi', 'raw'];
const EVENT_LOG_FALLBACKS = ['stderr', 'stdout'];
const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'];
// What the `bytes` package (used by express.text) accepts: a number of bytes, or a
// number with a b/kb/mb/gb suffix.
// envConfig field -> the variable name an operator actually sets.
const POOL_ENV_NAMES = Object.freeze({
  poolMin: 'ORACLE_POOL_MIN',
  poolMax: 'ORACLE_POOL_MAX',
  poolIncrement: 'ORACLE_POOL_INCREMENT',
  poolTimeout: 'ORACLE_POOL_TIMEOUT',
  queueTimeout: 'ORACLE_QUEUE_TIMEOUT',
  stmtCacheSize: 'ORACLE_STMT_CACHE_SIZE'
});

const BODY_LIMIT_PATTERN = /^\d+(\.\d+)?\s*(b|kb|mb|gb|tb)?$/i;

// Environment variable name -> the envConfig field it populates. Names are kept so
// the error message points at the variable an operator actually sets.
const ORACLE_CREDENTIALS = Object.freeze([
  ['ORACLE_USER', 'oracleUser'],
  ['ORACLE_PASSWORD', 'oraclePassword'],
  ['ORACLE_CONNECTION', 'oracleConnectString']
]);

function collectProblems() {
  const problems = [];

  if (!Number.isInteger(envConfig.port) || envConfig.port < 1 || envConfig.port > 65535) {
    problems.push(`PORT must be an integer between 1 and 65535 (received: ${envConfig.port})`);
  }

  if (!STRING_RESPONSE_MODES.includes(envConfig.stringResponseMode)) {
    problems.push(
      `STRING_RESPONSE_MODE must be one of ${STRING_RESPONSE_MODES.join(' | ')} ` +
        `(received: ${envConfig.stringResponseMode || '<empty>'})`
    );
  }

  if (!EVENT_LOG_FALLBACKS.includes(envConfig.eventLogFallback)) {
    problems.push(
      `EVENT_LOG_FALLBACK must be one of ${EVENT_LOG_FALLBACKS.join(' | ')} ` +
        `(received: ${envConfig.eventLogFallback || '<empty>'})`
    );
  }

  if (!LOG_LEVELS.includes(envConfig.logLevel)) {
    problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(' | ')} (received: ${envConfig.logLevel || '<empty>'})`);
  }

  if (!BODY_LIMIT_PATTERN.test(envConfig.bodyLimit)) {
    problems.push(
      `BODY_LIMIT must be a byte count, optionally suffixed with b/kb/mb/gb (received: ` +
        `${envConfig.bodyLimit || '<empty>'})`
    );
  }

  for (const [key, value] of Object.entries(envConfig.oraclePool)) {
    if (!Number.isInteger(value) || value < 0) {
      problems.push(`${POOL_ENV_NAMES[key]} must be a non-negative integer (received: ${value})`);
    }
  }

  if (!Number.isInteger(envConfig.shutdownTimeoutMs) || envConfig.shutdownTimeoutMs < 0) {
    problems.push(`SHUTDOWN_TIMEOUT_MS must be a non-negative integer (received: ${envConfig.shutdownTimeoutMs})`);
  }

  // server.js always creates the Oracle pool at startup, so these are always required.
  for (const [variableName, field] of ORACLE_CREDENTIALS) {
    if (!String(envConfig[field] || '').trim()) {
      problems.push(`${variableName} is required to create the Oracle connection pool but is empty or unset`);
    }
  }

  problems.push(...collectRoutingProblems());

  return problems;
}

/**
 * Validates the database routing map and every credential it references.
 *
 * The point is that a routing mistake fails the DEPLOY rather than the first request
 * that happens to use the broken route. Without this, adding a connection whose
 * DB_X_PASSWORD was never set in the platform's environment looks completely healthy
 * until the one source mapped to it sends traffic - potentially days later, and only
 * for that source.
 *
 * Loading the registry is itself part of the check: readConnectionRegistry throws a
 * ConfigurationError listing every structural problem at once, and that message is
 * surfaced here verbatim rather than being reduced to "could not load".
 */
function collectRoutingProblems() {
  let registry;
  try {
    registry = tenantRegistry.getTenantRegistry();
  } catch (error) {
    // Already a fully-formed, multi-line diagnostic; keep it intact.
    return [error.message];
  }

  const problems = tenantRegistry
    .missingConnectionCredentials(registry)
    .map((key) => `${key} is required by a block in config/tenants.jsonc but is empty or unset`);

  // A block carrying ciphertext with no passphrase configured would otherwise fail at
  // the first request that uses that block, naming neither the block nor the variable.
  if (tenantRegistry.requiresEncryptionKey(registry) && !String(envConfig.configEncryptionKey || '').trim()) {
    problems.push(
      'CONFIG_ENCRYPTION_KEY is required because a block in config/tenants.jsonc has an ' +
        'encrypted connectionString, but it is empty or unset'
    );
  }

  // A key that is set but WRONG would otherwise pass every check above, start the
  // service, and fail each request with an opaque `bad decrypt`.
  for (const name of tenantRegistry.undecryptableBlocks(registry)) {
    problems.push(
      `the connectionString for block "${name}" cannot be decrypted with the configured ` +
        'CONFIG_ENCRYPTION_KEY. Either the key is wrong, or the value was encrypted with a ' +
        'different one - re-encrypt it with `npm run encrypt-secret`'
    );
  }

  return problems;
}

function emitWarnings() {
  if (envConfig.exposeErrors) {
    appLogger.warn(
      'EXPOSE_ERRORS is enabled: unhandled errors will return their message and full stack trace ' +
        'to HTTP callers, disclosing filesystem paths and module layout. Disable this in production.'
    );
  }
}

/**
 * Validates the process environment. Throws a single aggregated error listing every
 * problem, so one restart surfaces all of them rather than one per attempt.
 * @throws {Error}
 */
function validateEnv() {
  const problems = collectProblems();

  if (problems.length > 0) {
    const detail = problems.map((problem) => `  - ${problem}`).join('\n');
    const error = new Error(`Invalid environment configuration:\n${detail}`);
    // Tagged so the startup handler can print it as readable text rather than
    // burying a multi-line message inside JSON metadata.
    error.name = 'ConfigurationError';
    throw error;
  }

  emitWarnings();
}

module.exports = { validateEnv, collectProblems };
