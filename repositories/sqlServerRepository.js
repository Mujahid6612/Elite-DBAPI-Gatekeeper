'use strict';

const { fixNullString } = require('../utils/nullHelpers');
const { STORED_PROC_PARAMS, RESPONSE_PARAM } = require('./storedProcContract');
const appLogger = require('../utils/appLogger');

/**
 * Loads the optional `mssql` driver on demand, so Oracle-only deployments never
 * need it installed. Declared as an optionalDependency in package.json.
 */
function loadDriver() {
  try {
    return require('mssql');
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    throw new Error("SQL Server tenants (dbType=1) require the optional 'mssql' package. Run: npm install mssql");
  }
}

/**
 * Cached connection pools, keyed by connection string so a multi-tenant deployment
 * with distinct targets keeps one pool each.
 *
 * Entries are stored as promises so concurrent first-callers share a single
 * in-flight connect rather than racing to create duplicate pools. A failed connect
 * is evicted so the next request retries instead of caching the rejection.
 */
const pools = new Map();

function acquirePool(sql, connectionString) {
  const existing = pools.get(connectionString);
  if (existing) return existing;

  const pending = Promise.resolve(sql.connect(connectionString)).catch((error) => {
    pools.delete(connectionString);
    throw error;
  });
  pools.set(connectionString, pending);
  return pending;
}

/**
 * Closes every cached pool. Called during graceful shutdown so SQL Server sessions
 * are released rather than left to time out server-side.
 */
async function closeAllPools() {
  const open = [...pools.values()];
  pools.clear();

  await Promise.all(
    open.map(async (poolPromise) => {
      try {
        const pool = await poolPromise;
        await pool.close();
      } catch (error) {
        appLogger.warn('Failed to close SQL Server pool', { message: error && error.message });
      }
    })
  );
}

/**
 * Maps the shared stored-procedure contract onto mssql request parameters.
 * `string` params carry a declared width; `lob` params use NVARCHAR(MAX).
 */
function bindParameters(sql, request, args) {
  const typeFor = (param) => {
    if (param.kind === 'lob') return sql.NVarChar(sql.MAX);
    if (param.kind === 'number') return sql.Int;
    return sql.VarChar(param.maxSize);
  };

  for (const param of STORED_PROC_PARAMS) {
    if (param.direction === 'in') {
      request.input(param.name, typeFor(param), fixNullString(args[param.arg]));
    } else {
      request.output(param.name, typeFor(param));
    }
  }
}

/**
 * Executes the tenant's stored procedure against SQL Server. Loaded lazily
 * so the `mssql` dependency is only required when a `dbType=1` tenant is
 * actually exercised (no Oracle tenant currently uses this path).
 * @param {string} connectionString
 * @param {string} procName
 * @param {import('../types').StoredProcArgs} args
 * @returns {Promise<import('../types').StoredProcResult>}
 */
async function execute(connectionString, procName, args) {
  const sql = loadDriver();

  // The pool is intentionally not closed after the call. `sql.connect()` hands back
  // mssql's process-wide pool, so closing it per request destroyed it for every other
  // in-flight caller and forced a full TCP+TLS+auth handshake on the next one.
  // Connections return to the pool on their own; pools are closed at shutdown by
  // closeAllPools().
  const pool = await acquirePool(sql, connectionString);
  const request = pool.request();
  bindParameters(sql, request, args);

  const result = await request.execute(procName);

  return {
    output: fixNullString(result.output[RESPONSE_PARAM]),
    oCode: fixNullString(result.output.oCode),
    oMessage: fixNullString(result.output.oMessage)
  };
}

module.exports = { execute, closeAllPools };
