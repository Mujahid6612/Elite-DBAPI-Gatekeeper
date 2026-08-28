'use strict';

/**
 * Chooses which database driver should run the request.
 *
 * WHY IT EXISTS: A configuration block can point at Oracle or SQL Server, and each needs
 *                completely different code.
 *
 * ROLE IN THE FLOW: The fork in the road between the two drivers. Called once the request is ready
 *                   to reach a database.
 */

const { DataBaseType } = require('../constants');
const { fixNullInt } = require('../utils/nullHelpers');
const oracleRepository = require('./oracleRepository');
const sqlServerRepository = require('./sqlServerRepository');

/**
 * Dispatches a tenant's stored-procedure call to the driver matching its
 * configured `dbType`. `dbType=2` (Oracle) is the only tenant currently
 * configured in config/tenants.jsonc; `dbType=1` (SQL Server) is supported for
 * parity with the source app's driver coverage. `dbType=0` (OLE DB) has no
 * portable Node.js equivalent and is rejected explicitly.
 *
 * `connection` is the descriptor resolved from the request's Source/Target by
 * config/tenantRegistry.js, and it decides WHICH database is reached. It is
 * optional here only so the startup smoke check and the existing driver-level tests
 * can call through without inventing a route; the request path always supplies it,
 * and omitting it falls back to the default ORACLE_* pool.
 *
 * `connectionString` remains the tenant's decrypted `targetDBConnectionString` and is
 * still used ONLY by the SQL Server driver. On the Oracle path it has never been
 * used - that is the illusion of per-tenant targeting the routing map replaces. When
 * a route resolves to a SQL Server connection, the route's connect string wins.
 *
 * @param {{connection?: object, connectionString: string, dbType: string|number, procName: string} & import('../types').StoredProcArgs} request
 * @returns {Promise<import('../types').StoredProcResult>}
 */
async function processDbRequest({ connection, connectionString, dbType, procName, ...args }) {
  const type = fixNullInt(dbType);

  if (type === DataBaseType.ORACLEDB) {
    return oracleRepository.execute(procName, args, connection);
  }

  if (type === DataBaseType.SQLDB) {
    const target = connection && connection.connectString ? connection.connectString : connectionString;
    return sqlServerRepository.execute(target, procName, args);
  }

  throw new Error('OLE DB (dbType=0) has no portable Node.js equivalent and is not used by any configured block.');
}

// Only the engine-agnostic dispatcher belongs here. Pool lifecycle is Oracle-specific
// and is owned by repositories/oracleRepository.js; ADO connection-string parsing lives
// in repositories/adoConnectionString.js. Re-exporting them through this facade made it
// look as though a SQL-Server-only deployment could call getPool(), which it cannot.
module.exports = { processDbRequest };
