'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const oracledb = require('oracledb');
const envConfig = require('../config/env');
const appLogger = require('../utils/appLogger');
const { fixNullString } = require('../utils/nullHelpers');
const { STORED_PROC_PARAMS, INPUT_PARAMS, RESPONSE_PARAM } = require('./storedProcContract');

let oraclePool = null;
let oracleClientInitialized = false;

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

/** Creates the shared Oracle connection pool from environment credentials. */
async function connectDB() {
  initializeOracleClient();

  const configDir = materializeTnsNames() || envConfig.oracleConfigDir;

  if (configDir) {
    // The Oracle client also reads TNS_ADMIN out-of-band (Thick mode, and
    // node-oracledb's own fallback), so the process variable is still exported.
    process.env.TNS_ADMIN = configDir;
  }

  oraclePool = await oracledb.createPool({
    user: envConfig.oracleUser,
    password: envConfig.oraclePassword,
    connectString: envConfig.oracleConnectString, // TNS alias from tnsnames.ora
    // Where tnsnames.ora lives. `|| undefined` is equivalent to the previous
    // `process.env.TNS_ADMIN` read: node-oracledb resolves this internally as
    // `options.configDir || process.env.TNS_ADMIN || ''`, so an empty string and
    // undefined take the same path (see lib/impl/parserHelpers.js).
    configDir: configDir || undefined,
    // Only explicitly configured tuning keys appear here; with none set this spread
    // adds nothing and the driver's own defaults apply, exactly as before.
    ...envConfig.oraclePool
  });

  return oraclePool;
}

/**
 * Closes the shared pool, letting in-flight statements finish within `drainSeconds`.
 * Called during graceful shutdown so Oracle sessions are released promptly instead of
 * being left for the server to time out.
 */
async function closePool(drainSeconds = 10) {
  if (!oraclePool) return;

  const pool = oraclePool;
  oraclePool = null;
  try {
    await pool.close(drainSeconds);
  } catch (error) {
    appLogger.warn('Failed to close Oracle pool', { message: error && error.message });
  }
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
async function ensurePool() {
  if (oraclePool) return oraclePool;

  if (!poolCreation) {
    poolCreation = connectDB().finally(() => {
      poolCreation = null;
    });
  }
  return poolCreation;
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
 * @param {string} procName
 * @param {import('../types').StoredProcArgs} args
 * @returns {Promise<import('../types').StoredProcResult>}
 */
async function execute(procName, args) {
  // ensurePool() rather than getPool(): identical once server.js has run, but on a
  // serverless cold start this is where the pool actually gets created.
  const pool = await ensurePool();
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

module.exports = {
  connectDB,
  ensurePool,
  getPool,
  closePool,
  execute,
  readLob,
  verifyConnectable,
  initializeOracleClient
};
