'use strict';

/**
 * Loads config/tenants.jsonc and works out which block a request belongs to.
 *
 * WHY IT EXISTS: This is where the Source and Target a client sends turn into an actual database,
 *                stored procedure and company number.
 *
 * ROLE IN THE FLOW: The routing decision. Called once per request, just after the body is parsed.
 */

/**
 * Loads `config/tenants.jsonc` and resolves a request to the block that configures it.
 *
 * REPLACES the whole XML layer - `config.xml`, `configReader.js`, `configSource.js`,
 * `xmlSettingsParser.js` and `configReaderProvider.js`. Those selected a block by
 * matching the request's **Host header** against `<sourceWebsite>`. Selection is now
 * by the **`Source` and `Target`** values inside `JsonReq.JHeader`, which is what the
 * calling application actually identifies itself with.
 *
 * THE SHAPE.
 *
 *   {
 *     "default":   { …block…                       },   // used before the body is parsed
 *     "databases": [ { "sources": [...], "target": "DBAPI", …block… } ]
 *   }
 *
 * MANY-TO-ONE IS THE POINT. A block lists every source that shares it:
 *
 *   "sources": ["NativeApp", "WebApp", "EliteWebsite"], "target": "DBAPI"
 *
 * All three then reach the same database with the same companyNum, procName and audit
 * settings. One-to-one is just a block with a single source.
 *
 * WHY THERE IS A `default` BLOCK. The audit log and the IP gate run BEFORE the body is
 * parsed - `services/processRequestService.js` writes the REQUEST line and the `-1:`
 * marker first, and that order is contractual. Source and Target do not exist yet at
 * that point, so something has to supply logType, logPath and the IP policy for those
 * two steps. The `default` block does, and the matched block takes over for everything
 * after the parse. It is also the tenant for routes that carry no envelope at all -
 * FlightView, the diagnostic GET, the access log and 404s.
 *
 * CACHING. Loaded once. The previous XML reader deliberately re-read on every request
 * so a settings edit applied without a restart; that is not carried over, because a
 * block now names environment variables and holds ciphertext decrypted with an
 * environment passphrase, and both of those are fixed at process start. Re-reading
 * would apply half a change - the very thing that produces a confusing outage.
 */

const fs = require('fs');
const path = require('path');
const envConfig = require('./env');
const Tenant = require('./tenant');
const { parseAdoConnectionString } = require('../repositories/adoConnectionString');
const { parseJsonWithComments } = require('../utils/jsonWithComments');

/** Fields a database block may declare. Anything else is a typo worth reporting. */
const KNOWN_FIELDS = Object.freeze([
  'sources',
  'target',
  'projectName',
  'companyNum',
  'whitelistedIPs',
  'blacklistedIPs',
  'enableLogging',
  'apiUserName',
  'apiPassword',
  'connectionString',
  'envPrefix',
  'poolMax',
  'dbType',
  'driverType',
  'procName',
  'logType',
  'logPath',
  // Optional and unread: JSON has no comments, so this exists only as an escape hatch
  // for a per-block note. The shipped file uses none - the explanation belongs in
  // README.md, where it can be read without being JSON-escaped.
  'description'
]);

function defaultTenantsPath() {
  // .jsonc, not .json: the file carries comments, and the extension is what tells
  // editors to accept them instead of flagging every one as a syntax error.
  return path.join(envConfig.projectRoot, 'config', 'tenants.jsonc');
}

/** Tags an error so server.js prints it as readable text rather than a stack. */
function configurationError(message) {
  const error = new Error(message);
  error.name = 'ConfigurationError';
  return error;
}

/** Case-insensitive lookup key. Source and Target are identifiers, not payload. */
function routeKey(source, target) {
  return `${String(source).trim().toUpperCase()} ${String(target).trim().toUpperCase()}`;
}

/**
 * Reads and validates the configuration. Pure - no caching - so tests can point it at
 * a fixture.
 *
 * Validation is total: every problem is collected and reported in one message, because
 * a half-valid configuration is otherwise discovered one broken source at a time, in
 * production, days apart.
 */
function readTenantRegistry(filePath = defaultTenantsPath()) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    throw configurationError(
      `Tenant configuration could not be read at ${filePath}: ${error.message}\n` +
        '  This file is required. It defines the default block and every database.'
    );
  }

  let document;
  try {
    // Comments are permitted, as in tsconfig.json: this file decides which database
    // every application reaches, and it needs to explain WHY a value is what it is -
    // particularly why several fields are deliberately left empty.
    document = parseJsonWithComments(raw);
  } catch (error) {
    throw configurationError(`Tenant configuration at ${filePath} is not valid JSON: ${error.message}`);
  }

  const problems = [];
  const routes = new Map();
  const blocks = [];

  if (!document.default || typeof document.default !== 'object') {
    problems.push('"default" block is missing; it supplies logging and the IP gate before the body is parsed');
  }

  const databases = Array.isArray(document.databases) ? document.databases : [];
  if (databases.length === 0) problems.push('"databases" is missing or empty; no request could ever be routed');

  for (const [index, block] of databases.entries()) {
    // projectName IS the identifier, so it is also what names a block in its own
    // validation errors - `databases[3]` would leave you counting brackets.
    const where = block && block.projectName ? `databases["${block.projectName}"]` : `databases[${index}]`;
    const entry = block && typeof block === 'object' ? block : {};

    const sources = Array.isArray(entry.sources) ? entry.sources.map((s) => String(s).trim()).filter(Boolean) : [];
    const target = String(entry.target || '').trim();

    if (!String(entry.projectName || '').trim()) {
      problems.push(`${where}: "projectName" is required - it identifies the block in logs and health checks`);
    }
    if (sources.length === 0) problems.push(`${where}: "sources" must list at least one source name`);
    if (!target) problems.push(`${where}: "target" is required`);

    // A database block that omits these LOADS fine but fails every request it serves:
    // an empty dbType coerces to 0, which is OLE DB and rejected, and an empty procName
    // would generate `BEGIN (...); END;`. Catching it here keeps the promise the rest of
    // this validation makes - a configuration mistake stops the deploy, not the first
    // customer request days later. The `default` block is exempt: it never dispatches.
    for (const field of ['companyNum', 'procName', 'dbType']) {
      if (!String(entry[field] === undefined || entry[field] === null ? '' : entry[field]).trim()) {
        problems.push(`${where}: "${field}" is required on a database block`);
      }
    }

    // A misspelled field is silently ignored by every getter, so the block would run
    // with a default nobody intended - report it instead.
    for (const field of Object.keys(entry)) {
      if (!KNOWN_FIELDS.includes(field)) problems.push(`${where}: unknown field "${field}"`);
    }

    if (entry.connectionString && entry.envPrefix) {
      problems.push(`${where}: set either "connectionString" or "envPrefix", not both`);
    }

    if (entry.poolMax !== undefined && entry.poolMax !== null && entry.poolMax !== '') {
      const poolMax = Number(entry.poolMax);
      if (!Number.isInteger(poolMax) || poolMax < 1) {
        problems.push(`${where}: "poolMax" must be a positive whole number (received: ${entry.poolMax})`);
      }
    }

    if (sources.length === 0 || !target) continue;

    const tenant = new Tenant(entry);
    blocks.push(tenant);

    for (const source of sources) {
      const key = routeKey(source, target);
      const existing = routes.get(key);
      if (existing) {
        // Matching upper-cases both sides, so 'WebApp' and 'EliteIDWebApp' are
        // the same route - two blocks claiming it is a configuration mistake.
        problems.push(
          `${where}: source "${source}" with target "${target}" is already served by "${existing.projectName}"`
        );
        continue;
      }
      routes.set(key, tenant);
    }
  }

  if (problems.length > 0) {
    throw configurationError(
      `Invalid tenant configuration (${filePath}):\n${problems.map((p) => `  - ${p}`).join('\n')}`
    );
  }

  return Object.freeze({
    default: new Tenant({ ...document.default }),
    routes,
    blocks,
    path: filePath
  });
}

let cached = null;

function getTenantRegistry() {
  if (!cached) cached = readTenantRegistry();
  return cached;
}

/** Test seam: drops the cached registry so the next call re-reads. */
function resetTenantRegistry() {
  cached = null;
}

/**
 * The block used before `Source`/`Target` are known, and for every route that carries
 * no envelope. See "WHY THERE IS A `default` BLOCK" above.
 */
function defaultTenant(registry = getTenantRegistry()) {
  return registry.default;
}

/**
 * @returns {Tenant|null} the block serving this pair, or null when none does - which
 *   callers must translate into a client-facing refusal rather than a fallback.
 */
function resolveTenant(source, target, registry = getTenantRegistry()) {
  return registry.routes.get(routeKey(source, target)) || null;
}

/**
 * Builds the Oracle credentials a block connects with, from whichever of the three
 * sources it declares. Precedence is fixed, and validation rejects declaring two:
 *
 *   1. `connectionString` - an encrypted ADO string, decrypted with CONFIG_ENCRYPTION_KEY
 *      and split into user / password / Data Source;
 *   2. `envPrefix`        - `<PREFIX>_USER`, `_PASSWORD`, `_CONNECT_STRING`;
 *   3. neither            - the default ORACLE_USER / ORACLE_PASSWORD / ORACLE_CONNECTION,
 *                           i.e. the single database used before any of this existed.
 *
 * `poolKey` is credential IDENTITY, not the block name: blocks that resolve to the same
 * credentials share one Oracle pool rather than opening a second one for the same
 * database. That is what keeps `instances x blocks x poolMax` from multiplying.
 *
 * @param {Tenant} tenant
 * @returns {{name: string, poolKey: string, user: string, password: string, connectString: string, poolMax: number|undefined}}
 */
function connectionFor(tenant) {
  const cipherText = String(tenant._block.connectionString || '').trim();

  if (cipherText !== '') {
    // Decrypts here rather than at load, so a wrong CONFIG_ENCRYPTION_KEY surfaces as
    // a named ConfigurationError on the route that uses it, not as a startup crash
    // that names no block.
    const ado = parseAdoConnectionString(tenant.targetDBConnectionString);
    return {
      name: tenant.projectName,
      // Two blocks holding the same connection string are the same database.
      poolKey: `cs:${cipherText}`,
      user: ado['user id'] || ado.uid || '',
      password: ado.password || ado.pwd || '',
      connectString: ado['data source'] || ado.server || '',
      poolMax: tenant.poolMax
    };
  }

  const prefix = tenant.envPrefix;
  const secrets = envConfig.readConnectionSecrets(prefix);
  return {
    name: tenant.projectName,
    poolKey: prefix ? `env:${prefix}` : '',
    ...secrets,
    poolMax: tenant.poolMax
  };
}

/** Every distinct database block, for health checks and startup probes. */
function allBlocks(registry = getTenantRegistry()) {
  return registry.blocks;
}

/** Human-readable route list, for logs and startup diagnostics. */
function describeRoutes(registry = getTenantRegistry()) {
  const lines = [];
  for (const block of registry.blocks) {
    for (const source of block.sources) lines.push(`${source}/${block.target} -> ${block.projectName}`);
  }
  return lines.sort();
}

/** Environment variables the configuration depends on, for validateEnv and the drift test. */
function requiredConnectionEnvKeys(registry = getTenantRegistry()) {
  const keys = new Set();
  for (const block of registry.blocks) {
    if (!block.envPrefix) continue;
    for (const suffix of envConfig.CONNECTION_SECRET_SUFFIXES) keys.add(`${block.envPrefix}_${suffix}`);
  }
  return [...keys].sort();
}

/** Names every credential variable a block depends on that is empty or unset. */
function missingConnectionCredentials(registry = getTenantRegistry()) {
  const missing = new Set();
  for (const block of registry.blocks) {
    const prefix = block.envPrefix;
    if (!prefix) continue;
    const secrets = envConfig.readConnectionSecrets(prefix);
    for (const [suffix, value] of [
      ['USER', secrets.user],
      ['PASSWORD', secrets.password],
      ['CONNECT_STRING', secrets.connectString]
    ]) {
      if (!String(value || '').trim()) missing.add(`${prefix}_${suffix}`);
    }
  }
  return [...missing].sort();
}

/** True when at least one block carries ciphertext, so a passphrase is required. */
function requiresEncryptionKey(registry = getTenantRegistry()) {
  return registry.blocks.some((block) => String(block._block.connectionString || '').trim() !== '');
}

module.exports = {
  readTenantRegistry,
  getTenantRegistry,
  resetTenantRegistry,
  defaultTenant,
  resolveTenant,
  allBlocks,
  describeRoutes,
  requiredConnectionEnvKeys,
  missingConnectionCredentials,
  requiresEncryptionKey,
  connectionFor,
  defaultTenantsPath,
  routeKey,
  KNOWN_FIELDS
};
