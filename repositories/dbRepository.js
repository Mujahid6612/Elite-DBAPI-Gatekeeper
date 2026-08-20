'use strict';

const { DataBaseType } = require('../constants');
const { fixNullInt } = require('../utils/nullHelpers');
const oracleRepository = require('./oracleRepository');
const sqlServerRepository = require('./sqlServerRepository');

/**
 * Dispatches a tenant's stored-procedure call to the driver matching its
 * configured `dbType`. `dbType=2` (Oracle) is the only tenant currently
 * configured in `config.xml`; `dbType=1` (SQL Server) is supported for
 * parity with the source app's driver coverage. `dbType=0` (OLE DB) has no
 * portable Node.js equivalent and is rejected explicitly.
 * @param {{connectionString: string, dbType: string|number, procName: string} & import('../types').StoredProcArgs} request
 * @returns {Promise<import('../types').StoredProcResult>}
 */
async function processDbRequest({ connectionString, dbType, procName, ...args }) {
  const type = fixNullInt(dbType);

  if (type === DataBaseType.ORACLEDB) {
    return oracleRepository.execute(procName, args);
  }

  if (type === DataBaseType.SQLDB) {
    return sqlServerRepository.execute(connectionString, procName, args);
  }

  throw new Error('OLE DB (dbType=0) has no portable Node.js equivalent and is not used by the supplied config.xml.');
}

// Only the engine-agnostic dispatcher belongs here. Pool lifecycle is Oracle-specific
// and is owned by repositories/oracleRepository.js; ADO connection-string parsing lives
// in repositories/adoConnectionString.js. Re-exporting them through this facade made it
// look as though a SQL-Server-only deployment could call getPool(), which it cannot.
module.exports = { processDbRequest };
