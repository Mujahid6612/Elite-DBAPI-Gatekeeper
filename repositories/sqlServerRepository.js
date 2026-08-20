'use strict';

const { fixNullString } = require('../utils/nullHelpers');

/**
 * Executes the tenant's stored procedure against SQL Server. Loaded lazily
 * so the `mssql` dependency is only required when a `dbType=1` tenant is
 * actually exercised (no Oracle tenant currently uses this path).
 */
async function execute(connectionString, procName, args) {
  // Load this optional driver only for SQL Server tenants.
  const sql = require('mssql');
  const pool = await sql.connect(connectionString);

  try {
    const request = pool.request();
    request.input('pActionCode', sql.VarChar(100), fixNullString(args.actionCode));
    request.input('pCompanyNum', sql.VarChar(3), fixNullString(args.companyNum));
    request.input('pViewName', sql.VarChar(100), fixNullString(args.viewName));
    request.input('pClientIP', sql.VarChar(50), fixNullString(args.clientIP));
    request.input('pJsonReq', sql.NVarChar(sql.MAX), fixNullString(args.jsonReq));
    request.input('pNotes', sql.NVarChar(sql.MAX), fixNullString(args.notes));
    request.output('oCode', sql.Int);
    request.output('oMessage', sql.VarChar(4000));
    request.output('oJsonResp', sql.NVarChar(sql.MAX));

    const result = await request.execute(procName);

    return {
      output: fixNullString(result.output.oJsonResp),
      oCode: fixNullString(result.output.oCode),
      oMessage: fixNullString(result.output.oMessage)
    };
  } finally {
    await pool.close();
  }
}

module.exports = { execute };
