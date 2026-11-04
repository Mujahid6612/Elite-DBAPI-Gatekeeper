'use strict';

/**
 * The same job as oracleRepository.js, but for MySQL (dbType 3).
 *
 * WHY IT EXISTS: The BlinkRide backend keeps its data in MySQL behind a `request_handler`
 *                stored procedure that takes the whole request as a JSON session variable.
 *
 * ROLE IN THE FLOW: Only reached when a block is set to dbType 3. It translates the shared
 *                   Gatekeeper contract into that procedure's calling convention.
 */

const mysql = require('mysql2/promise');
const envConfig = require('../config/env');
const appLogger = require('../utils/appLogger');
const { fixNullString } = require('../utils/nullHelpers');

/**
 * Pools keyed by credential identity (`connection.poolKey`), so blocks that point at the same
 * database share one pool. Entries are promises-free: mysql2 connects lazily, so creating a
 * pool cannot hang and a bad host only fails the first query.
 */
const pools = new Map();

/** Session variable the procedure reads the request from, and the one it answers in. */
const REQUEST_VARIABLE = '@reqObj';
const RESPONSE_VARIABLE = '@pjObj';

const SSL_OFF = new Set(['', 'none', 'false', 'disabled', 'off', '0']);

/**
 * Splits the connection descriptor's `connectString` into host, port and database.
 *
 * Two spellings are accepted. An ADO-style string (`Server=h;Port=3306;Database=d;SslMode=Required`)
 * is what an encrypted `connectionString` decrypts to, and `host[:port][/database]` is what a
 * `<PREFIX>_CONNECT_STRING` environment variable holds.
 *
 * @param {string} connectString
 * @returns {{host: string, port: number, database: string, ssl: boolean}}
 */
function parseTarget(connectString) {
  const raw = String(connectString || '').trim();

  if (raw.includes('=')) {
    const fields = {};
    for (const pair of raw.split(';')) {
      const at = pair.indexOf('=');
      if (at === -1) continue;
      fields[pair.slice(0, at).trim().toLowerCase()] = pair.slice(at + 1).trim();
    }
    const sslMode = String(fields['ssl mode'] || fields.sslmode || fields.ssl || '').toLowerCase();
    return {
      host: fields['data source'] || fields.server || fields.host || '',
      port: Number.parseInt(fields.port, 10) || 3306,
      database: fields.database || fields['initial catalog'] || '',
      ssl: !SSL_OFF.has(sslMode)
    };
  }

  const [hostPort, ...rest] = raw.split('/');
  const [host, port] = hostPort.split(':');
  return { host: host || '', port: Number.parseInt(port, 10) || 3306, database: rest.join('/'), ssl: false };
}

/**
 * Builds the mysql2 pool options for a routed connection.
 *
 * `connectTimeout` is what keeps an unreachable host from holding a serverless request until
 * the platform kills it, the same reason the Oracle pool sets one.
 */
function buildPoolOptions(connection) {
  const target = parseTarget(connection.connectString);
  const options = {
    host: target.host,
    port: target.port,
    user: connection.user,
    password: connection.password,
    database: target.database,
    waitForConnections: true,
    connectionLimit: connection.poolMax || 4,
    queueLimit: 0,
    connectTimeout: envConfig.mysqlConnectTimeoutMs
  };
  // 'Amazon RDS' is mysql2's bundled CA profile, the same value the BlinkRide backend uses.
  if (target.ssl) options.ssl = 'Amazon RDS';
  return options;
}

function poolFor(connection) {
  const key = String((connection && connection.poolKey) || '');
  const existing = pools.get(key);
  if (existing) return existing;

  const pool = mysql.createPool(buildPoolOptions(connection));
  pools.set(key, pool);
  appLogger.info(`Created MySQL pool: ${connection.name || key}`, { database: connection.name });
  return pool;
}

/**
 * The envelope sections and the camelCase spelling `request_handler` reads them under. MySQL JSON
 * paths are case-sensitive: the procedure looks for `$.jHeader.accessToken`, so a client that sends
 * `JHeader` (as the Gatekeeper's routing requires) would otherwise be told its credentials are not
 * valid. The reply uses the same lowercase keys.
 */
const SECTIONS = Object.freeze([
  ['JHeader', 'jHeader'],
  ['JMetaData', 'jMetaData'],
  ['JData', 'jData']
]);

/**
 * What the procedure receives: the client's `JsonReq` with the camelCase sections filled in from
 * their PascalCase twins. Nothing is removed or overwritten, so a client that already sends
 * camelCase (the BlinkRide backend) is untouched and a PascalCase one (Postman) gains the keys
 * the procedure reads. The PascalCase originals are kept in case anything reads those instead.
 *
 * Inside `jHeader`, `Source` and `Target` are also given as `source` and `target`, the spelling
 * the backend's own header uses.
 *
 * @returns {{request: string, jData: object}}
 */
function splitRequest(jsonReq) {
  try {
    const parsed = JSON.parse(jsonReq);
    if (!parsed || typeof parsed !== 'object') return { request: jsonReq, jData: {} };

    const request = { ...parsed };
    for (const [pascal, camel] of SECTIONS) {
      if (request[pascal] !== undefined && request[camel] === undefined) request[camel] = request[pascal];
    }

    if (request.jHeader && typeof request.jHeader === 'object') {
      const header = { ...request.jHeader };
      for (const key of ['Source', 'Target']) {
        const lower = key.toLowerCase();
        if (header[key] !== undefined && header[lower] === undefined) header[lower] = header[key];
      }
      request.jHeader = header;
    }

    const jData = request.jData && typeof request.jData === 'object' ? request.jData : {};
    // Re-serialised compactly: the parser pretty-prints JsonReq with CRLFs for Oracle.
    return { request: JSON.stringify(request), jData };
  } catch {
    // A body that is not JSON is still passed through as @reqObj; the procedure rejects it.
    return { request: jsonReq, jData: {} };
  }
}

/** The four plain arguments. `?? null` rather than a default: NULL means "not supplied". */
function procedureArguments(args, jData) {
  return [
    fixNullString(args.clientIP) || null,
    jData.P_AFFILIATE_NUM ?? null,
    jData.P_APP_NAME ?? null,
    args.actionCode
  ];
}

/** Applies the query timeout to one statement. 0/unset means no limit. */
function statement(sql) {
  return envConfig.mysqlQueryTimeoutMs ? { sql, timeout: envConfig.mysqlQueryTimeoutMs } : { sql };
}

/**
 * Executes `procName` against MySQL, using the calling convention BlinkRide's backend uses:
 *
 *   SET @reqObj = <request JSON>;
 *   CALL <procName>(clientIp, affiliateNum, appName, actionCode, @reqObj, @pjObj);
 *   SELECT @pjObj;
 *
 * MySQL has no `oCode`/`oMessage` outputs; the result code is inside the returned JSON
 * (`jHeader.responseCode`), which the caller reads, so both come back empty here.
 *
 * @param {object} connection descriptor from config/tenantRegistry.connectionFor
 * @param {string} procName
 * @param {import('../types').StoredProcArgs} args
 * @returns {Promise<import('../types').StoredProcResult>}
 */
async function execute(connection, procName, args) {
  if (!/^[A-Za-z0-9_$]+(\.[A-Za-z0-9_$]+)?$/.test(String(procName))) {
    throw new Error(`Invalid MySQL procedure name: ${procName}`);
  }

  const pool = poolFor(connection);
  const session = await pool.getConnection();

  try {
    const { request, jData } = splitRequest(args.jsonReq);
    await session.execute(statement(`SET ${REQUEST_VARIABLE} = ?`), [request]);

    const params = procedureArguments(args, jData);
    const placeholders = params.map(() => '?').join(', ');
    await session.execute(
      statement(`CALL ${procName}(${placeholders}, ${REQUEST_VARIABLE}, ${RESPONSE_VARIABLE})`),
      params
    );

    const [rows] = await session.execute(statement(`SELECT ${RESPONSE_VARIABLE} AS response`));
    const response = Array.isArray(rows) && rows.length > 0 ? rows[0].response : undefined;
    if (response === undefined || response === null) {
      throw new Error('No response received from stored procedure');
    }

    // A JSON-typed variable arrives already parsed; the contract is text.
    const output = typeof response === 'string' ? response : JSON.stringify(response);
    return { output: fixNullString(output), oCode: '', oMessage: '' };
  } finally {
    session.release();
  }
}

/** Proves a routed MySQL connection can answer a query. Used by the health check. */
async function verifyConnectableFor(connection) {
  const pool = poolFor(connection);
  await pool.query(statement('SELECT 1'));
  return true;
}

/** Closes every pool. Called during graceful shutdown; a failure is logged, not thrown. */
async function closeAllPools() {
  const open = [...pools.values()];
  pools.clear();

  await Promise.all(
    open.map(async (pool) => {
      try {
        await pool.end();
      } catch (error) {
        appLogger.warn('Failed to close MySQL pool', { message: error && error.message });
      }
    })
  );
}

module.exports = { execute, verifyConnectableFor, closeAllPools, parseTarget };
