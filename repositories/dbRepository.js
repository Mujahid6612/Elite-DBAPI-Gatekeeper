'use strict';

const { DataBaseType } = require('../constants');
const { fixNullInt } = require('../utils/nullHelpers');
const oracleRepository = require('./oracleRepository');
const sqlServerRepository = require('./sqlServerRepository');
const { parseAdoConnectionString } = require('./adoConnectionString');

/**
 * @typedef {object} StoredProcArgs
 * @property {string} actionCode
 * @property {string} companyNum
 * @property {string} viewName
 * @property {string} clientIP
 * @property {string} jsonReq
 * @property {string} notes
 *
 * @typedef {object} StoredProcResult
 * @property {string} output
 * @property {string} oCode
 * @property {string} oMessage
 */

/**
 * Dispatches a tenant's stored-procedure call to the driver matching its
 * configured `dbType`. `dbType=2` (Oracle) is the only tenant currently
 * configured in `config.xml`; `dbType=1` (SQL Server) is supported for
 * parity with the source app's driver coverage. `dbType=0` (OLE DB) has no
 * portable Node.js equivalent and is rejected explicitly.
 * @param {{connectionString: string, dbType: string|number, procName: string} & StoredProcArgs} request
 * @returns {Promise<StoredProcResult>}
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

module.exports = {
  processDbRequest,
  connectDB: oracleRepository.connectDB,
  getPool: oracleRepository.getPool,
  testConnection: oracleRepository.testConnection,
  parseAdoConnectionString
};
