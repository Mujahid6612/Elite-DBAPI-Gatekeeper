'use strict';

/**
 * Everything to do with talking to Oracle: connections, pools and running the stored procedure.
 *
 * WHY IT EXISTS: All the real work of this service happens inside one Oracle stored procedure, so
 *                this file is where the actual database call is made.
 *
 * ROLE IN THE FLOW: The last stop before the database. It reuses connection pools so each database
 *                   is connected to once, not once per request.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const oracledb = require('oracledb');
const envConfig = require('../config/env');
const appLogger = require('../utils/appLogger');
const { fixNullString } = require('../utils/nullHelpers');
const { STORED_PROC_PARAMS, INPUT_PARAMS, RESPONSE_PARAM } = require('./storedProcContract');

/**
 * The DEFAULT pool, built from ORACLE_USER / ORACLE_PASSWORD / ORACLE_CONNECTION.
 * Kept as its own variable rather than folded into `namedPools` because it has a
 * lifecycle the others do not: server.js creates it at startup to fail fast on bad
 * credentials, and getPool()/verifyConnectable() assert on it.
 */
let oraclePool = null;

/**
 * Pools for routed connections that declare their own `envPrefix`, keyed BY THAT
 * PREFIX rather than by connection name.
 *
 * Keying on credentials, not on the label, is deliberate: two connections in
 * config/tenants.jsonc that resolve to the same credentials are the same database, and giving
 * them separate pools would silently double the Oracle sessions this process holds
 * for no benefit. A connection with no envPrefix uses the default credentials and
 * therefore shares the default pool, for the same reason.
 *
 * Entries are promises so concurrent first-callers share one in-flight connect, and a
 * failed attempt is evicted so the next request retries rather than being served a
 * cached rejection - the same contract sqlServerRepository.js uses.
 */
const namedPools = new Map();

let oracleClientInitialized = false;

/**
 * '' means "the default ORACLE_* credentials". See namedPools above.
 *
 * The key comes from `config/tenantRegistry.connectionFor`, which sets it from
 * CREDENTIAL identity - the envPrefix, or the ciphertext for an inline connection
 * string - never from the block name. Two blocks naming the same database therefore
 * share one pool instead of doubling the Oracle sessions this process holds.
 */
function poolKey(connection) {
  if (!connection) return '';
  if (connection.poolKey !== undefined) return String(connection.poolKey);
  // Older callers passed envPrefix directly; keep them working.
  return connection.envPrefix ? String(connection.envPrefix) : '';
}

/**
 * node-oracledb runs in Thin mode by default and needs no Oracle Client libraries.
 * Thick mode is opt-in via ORACLE_THICK_MODE, with ORACLE_CLIENT_LIB_DIR pointing at
 * the client install. Called from connectDB() rather than at module load so that
 * importing this module stays side-effect free (and testable on any platform).
 *
 * RESTORED (CQ-01): commit ace5004 replaced this with an unconditional
 * initOracleClient() call as a local workaround, which forced Thick mode regardless
 * of the flag. That cannot work on a host with no Instant Client - notably a Vercel
 * function, where it fails with DPI-1047 on the first request - and it silently
 * contradicted the documented meaning of ORACLE_THICK_MODE.
 */
function initializeOracleClient() {
  if (oracleClientInitialized || !envConfig.oracleThickMode) return;

  const options = {};
  if (envConfig.oracleClientLibDir) options.libDir = envConfig.oracleClientLibDir;
  oracledb.initOracleClient(options);
  oracleClientInitialized = true;
}

/**
 * Materializes a tnsnames.ora supplied through the environment and returns the
 * directory holding it, or '' when ORACLE_TNSNAMES is unset.
 *
 * `.gitignore` excludes `*.ora` and `tns/`, so the checked-in repository has no
 * tnsnames.ora and a deployment resolving a TNS ALIAS (ORACLE_CONNECTION=WebDev2023Wan)
 * fails with ORA-12154. Supplying the file's text as ORACLE_TNSNAMES keeps the alias
 * working without committing the network topology. The alternative - putting the full
 * connect descriptor directly in ORACLE_CONNECTION - also works and needs no file.
 *
 * Written under the OS temp directory because a serverless filesystem is read-only
 * everywhere else.
 */
function materializeTnsNames() {
  if (!envConfig.oracleTnsNames) return '';

  const directory = path.join(os.tmpdir(), 'oracle-net');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'tnsnames.ora'), envConfig.oracleTnsNames, 'utf8');
  return directory;
}

/**
 * Creates the shared Oracle connection pool from environment credentials.
 *
 * PREFER ensurePool() unless you specifically mean "build a pool now". This
 * function is unconditional: it creates a pool and overwrites the module's
 * reference to any existing one, which ABANDONS that pool along with the database
 * sessions it holds. Calling it per request therefore leaks up to poolMax sessions
 * every time - services/healthInfoService.js did exactly that, so every health check
 * leaked a pool until it was switched to ensurePool().
 *
 * It stays unguarded because server.js legitimately calls it once at startup to
 * fail fast on bad credentials, and the connect-options tests assert on the exact
 * createPool call it makes.
 */
/**
 * Resolves the tnsnames.ora directory and exports it, once per process.
 *
 * Extracted so that creating a second pool for a routed connection does not
 * re-materialize the same tnsnames.ora file on every call. All connections share one
 * network-config directory: they are different databases, not different topologies.
 */
let resolvedConfigDir;
function ensureConfigDir() {
  if (resolvedConfigDir !== undefined) return resolvedConfigDir;

  const configDir = materializeTnsNames() || envConfig.oracleConfigDir;
  if (configDir) {
    // The Oracle client also reads TNS_ADMIN out-of-band (Thick mode, and
    // node-oracledb's own fallback), so the process variable is still exported.
    process.env.TNS_ADMIN = configDir;
  }
  resolvedConfigDir = configDir;
  return configDir;
}

/**
 * Builds the createPool option object for a connection, or for the default
 * credentials when `connection` is absent.
 *
 * The default shape is EXACTLY four keys - user, password, connectString, configDir -
 * and a test asserts that, so any tuning key must continue to come only from an
 * explicitly set ORACLE_POOL_* variable.
 */
function buildPoolOptions(connection) {
  const configDir = ensureConfigDir();
  const useDefault = poolKey(connection) === '';

  const options = {
    user: useDefault ? envConfig.oracleUser : connection.user,
    password: useDefault ? envConfig.oraclePassword : connection.password,
    // TNS alias from tnsnames.ora, or a full connect descriptor. For a block with an
    // inline connectionString this is the ADO `Data Source` value.
    connectString: useDefault ? envConfig.oracleConnectString : connection.connectString,
    // Where tnsnames.ora lives. `|| undefined` is equivalent to the previous
    // `process.env.TNS_ADMIN` read: node-oracledb resolves this internally as
    // `options.configDir || process.env.TNS_ADMIN || ''`, so an empty string and
    // undefined take the same path (see lib/impl/parserHelpers.js).
    configDir: configDir || undefined,
    // Only explicitly configured tuning keys appear here; with none set this spread
    // adds nothing and the driver's own defaults apply, exactly as before.
    ...envConfig.oraclePool
  };

  // A per-connection ceiling, for when one database needs a different budget. Total
  // sessions are (instances x connections x poolMax), so on a serverless host this is
  // usually the knob that matters most.
  if (!useDefault && connection.poolMax !== undefined) options.poolMax = connection.poolMax;

  return options;
}

async function connectDB(label = 'default (ORACLE_* environment)') {
  initializeOracleClient();

  oraclePool = await oracledb.createPool(buildPoolOptions(null));
  logConnected(label, buildPoolOptions(null).connectString);

  return oraclePool;
}

/** Closes one pool, downgrading a close failure to a warning. */
async function closeOne(pool, label, drainSeconds) {
  try {
    await pool.close(drainSeconds);
  } catch (error) {
    appLogger.warn('Failed to close Oracle pool', { pool: label, message: error && error.message });
  }
}

/**
 * Closes EVERY Oracle pool - the default one and each routed connection's - letting
 * in-flight statements finish within `drainSeconds`. Called during graceful shutdown
 * so sessions are released promptly instead of being left for the server to time out.
 *
 * The name is unchanged because server.js calls it, but the scope grew with routing:
 * closing only the default pool would strand the sessions held by every routed
 * connection, which is precisely the leak this exists to prevent.
 */
async function closePool(drainSeconds = 10) {
  const closing = [];

  if (oraclePool) {
    const pool = oraclePool;
    oraclePool = null;
    closing.push(closeOne(pool, 'default', drainSeconds));
  }

  for (const [key, pending] of namedPools) {
    namedPools.delete(key);
    closing.push(
      Promise.resolve(pending)
        .then((pool) => closeOne(pool, key, drainSeconds))
        // A pool that never finished connecting has nothing to close.
        .catch(() => {})
    );
  }

  await Promise.all(closing);
}

function getPool() {
  if (!oraclePool) {
    throw new Error('Oracle pool has not been initialized.');
  }
  return oraclePool;
}

/**
 * In-flight connectDB() promise, so concurrent first requests share one pool
 * creation instead of racing to build several and leaking all but the last.
 */
let poolCreation = null;

/**
 * Returns the pool, creating it on first use.
 *
 * server.js still calls connectDB() explicitly at startup, so a long-running process
 * behaves exactly as before and this is a no-op on every request. It exists for the
 * serverless entrypoint (api/index.js), where there is no startup hook to create the
 * pool in: without it the first request to a cold instance fails with
 * "Oracle pool has not been initialized."
 *
 * A failed attempt is not cached - `poolCreation` is cleared - so a request arriving
 * after a transient database outage retries rather than being served a stale
 * rejection for the life of the instance.
 */
async function ensurePool(label) {
  if (oraclePool) return oraclePool;

  if (!poolCreation) {
    poolCreation = connectDB(label).finally(() => {
      poolCreation = null;
    });
  }
  return poolCreation;
}

/**
 * Returns the pool for a routed connection, creating it on first use.
 *
 * A connection with no `envPrefix` uses the default credentials, so it is served by
 * the default pool rather than a duplicate of it - see the note on `namedPools`.
 *
 * @param {{name?: string, envPrefix?: string, user?: string, password?: string, connectString?: string}} [connection]
 */
async function poolFor(connection) {
  const key = poolKey(connection);
  // The block's projectName, so the log says WHICH database connected.
  const label = (connection && connection.name) || 'default (ORACLE_* environment)';

  if (key === '') return ensurePool(label);

  const existing = namedPools.get(key);
  if (existing) return existing;

  initializeOracleClient();

  const pending = oracledb
    .createPool(buildPoolOptions(connection))
    .then((pool) => {
      // Logged HERE, not on every request: a pool is created once and then reused, so
      // this line appearing twice for one database means something is building pools
      // it should be sharing.
      logConnected(label, connection.connectString);
      return pool;
    })
    .catch((error) => {
      // Not cached, so a database that was briefly unreachable is retried on the next
      // request instead of poisoning this connection for the life of the instance.
      namedPools.delete(key);
      appLogger.error(`Failed to connect to database: ${label}`, {
        database: label,
        message: error && error.message
      });
      throw error;
    });

  namedPools.set(key, pending);
  return pending;
}

/**
 * Announces a successful database connection, naming the block it belongs to.
 *
 * The name is the block's `projectName` from config/tenants.jsonc, so an operator
 * reading the log can tell WHICH database came up rather than only that "a" database
 * did - which matters as soon as more than one is configured.
 *
 * The connect string (a TNS alias or host) is included because two blocks can share a
 * projectName-like label while pointing somewhere different. Credentials are never
 * logged.
 */
function logConnected(label, connectString) {
  appLogger.info(`Connected to database: ${label}`, {
    database: label,
    connectString: connectString || '(from ORACLE_CONNECTION)'
  });
}

/** Reads Oracle CLOB/LOB output values into plain strings. */
async function readLob(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value.getData === 'function') return String(await value.getData());
  if (Buffer.isBuffer(value)) return value.toString('utf8');

  if (typeof value.on === 'function') {
    return new Promise((resolve, reject) => {
      let text = '';
      value.setEncoding?.('utf8');
      value.on('data', (chunk) => {
        text += chunk;
      });
      value.on('end', () => resolve(text));
      value.on('error', reject);
    });
  }

  return String(value);
}

/**
 * Releases a connection without letting a close failure mask the real error.
 *
 * A bare `await connection.close()` in a `finally` block replaces any in-flight
 * rejection with its own. That is worst exactly when it matters most: if execute()
 * failed because the connection broke, close() will usually fail too, and the
 * operator would see the close error instead of the actual ORA- diagnostic.
 */
async function closeQuietly(connection) {
  try {
    await connection.close();
  } catch (closeError) {
    appLogger.warn('Failed to close Oracle connection', {
      message: closeError && closeError.message
    });
  }
}

/**
 * Renders the anonymous PL/SQL block. The two parameter lines are split 6/3 exactly
 * as the original literal was, so the generated SQL text is byte-identical.
 */
function buildCallBlock(procName) {
  const names = STORED_PROC_PARAMS.map((param) => `:${param.name}`);
  const inputs = names.slice(0, INPUT_PARAMS.length).join(', ');
  const outputs = names.slice(INPUT_PARAMS.length).join(', ');

  return `
      BEGIN
        ${procName}(
          ${inputs},
          ${outputs}
        );
      END;
    `;
}

/** Maps the shared contract onto node-oracledb bind descriptors. */
function buildBinds(args) {
  const ORACLE_TYPES = {
    string: oracledb.STRING,
    lob: oracledb.DB_TYPE_CLOB,
    number: oracledb.NUMBER
  };

  const binds = {};
  for (const param of STORED_PROC_PARAMS) {
    const descriptor = {
      dir: param.direction === 'in' ? oracledb.BIND_IN : oracledb.BIND_OUT,
      type: ORACLE_TYPES[param.kind]
    };
    if (param.direction === 'in') descriptor.val = fixNullString(args[param.arg]);
    if (param.maxSize !== undefined) descriptor.maxSize = param.maxSize;
    binds[param.name] = descriptor;
  }
  return binds;
}

/**
 * Executes the tenant's stored procedure (default `REQUEST_HANDLER.ACTIONS`)
 * with the fixed 9-parameter bind contract carried over from the source app.
 *
 * `dbConnection` is the descriptor resolved from the request's Source/Target and
 * decides WHICH database this runs against. It is optional so the startup smoke check
 * and the driver-level tests can call through without inventing a route; omitting it
 * uses the default ORACLE_* pool, which is exactly the pre-routing behaviour.
 *
 * @param {string} procName
 * @param {import('../types').StoredProcArgs} args
 * @param {{name?: string, envPrefix?: string}} [dbConnection]
 * @returns {Promise<import('../types').StoredProcResult>}
 */
async function execute(procName, args, dbConnection) {
  // poolFor() rather than getPool(): identical once server.js has run for the default
  // connection, but on a serverless cold start this is where the pool actually gets
  // created, and for a routed connection it is the only place it is created at all.
  const pool = await poolFor(dbConnection);
  const connection = await pool.getConnection();

  try {
    // Use bind values so request data is never added directly to the call.
    const sql = buildCallBlock(procName);
    const binds = buildBinds(args);

    const result = await connection.execute(sql, binds);
    const output = await readLob(result.outBinds[RESPONSE_PARAM]);

    return {
      output: fixNullString(output),
      oCode: fixNullString(result.outBinds.oCode),
      oMessage: fixNullString(result.outBinds.oMessage)
    };
  } finally {
    await closeQuietly(connection);
  }
}

/**
 * Startup smoke check: proves the pool can hand out a usable connection, then
 * returns it. Deliberately does NOT run a query - this reproduces exactly what
 * server.js did inline before the check moved in here, so boot behavior (and the
 * database's own session/audit record of it) is unchanged.
 */
async function verifyConnectable() {
  const pool = getPool();
  const connection = await pool.getConnection();
  try {
    return true;
  } finally {
    await closeQuietly(connection);
  }
}

/**
 * Proves a ROUTED connection can hand out a usable session, creating its pool if it
 * does not exist yet.
 *
 * Separate from verifyConnectable() because that one asserts on the default pool via
 * getPool() and throws when it has not been built. Health checks must be able to probe
 * a connection that no request has used yet, which is exactly the one most likely to
 * be misconfigured.
 *
 * @param {{name?: string, envPrefix?: string}} [dbConnection]
 */
async function verifyConnectableFor(dbConnection) {
  const pool = await poolFor(dbConnection);
  const connection = await pool.getConnection();
  try {
    return true;
  } finally {
    await closeQuietly(connection);
  }
}

module.exports = {
  connectDB,
  ensurePool,
  poolFor,
  getPool,
  closePool,
  execute,
  readLob,
  verifyConnectable,
  verifyConnectableFor,
  initializeOracleClient
};
