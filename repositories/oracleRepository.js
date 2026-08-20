'use strict';

const oracledb = require('oracledb');
const envConfig = require('../config/env');
const { fixNullString } = require('../utils/nullHelpers');

let oraclePool = null;

// Oracle Client is required by the installed thick driver.
oracledb.initOracleClient({
    libDir: "C:\\app\\azs\\product\\21c\\dbhomeXE\\bin"
});

/** Creates the shared Oracle connection pool from environment credentials. */
async function connectDB() {
  if (envConfig.oracleConfigDir) {
    // Let Oracle find network files such as tnsnames.ora.
    process.env.TNS_ADMIN = envConfig.oracleConfigDir;
  }

  oraclePool = await oracledb.createPool({
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    connectString: process.env.ORACLE_CONNECTION, // TNS alias from tnsnames.ora
    configDir: process.env.TNS_ADMIN // Where tnsnames.ora lives.
  });

  return oraclePool;
}

function getPool() {
  if (!oraclePool) {
    throw new Error('Oracle pool has not been initialized.');
  }
  return oraclePool;
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
      value.on('data', (chunk) => { text += chunk; });
      value.on('end', () => resolve(text));
      value.on('error', reject);
    });
  }

  return String(value);
}

/**
 * Executes the tenant's stored procedure (default `REQUEST_HANDLER.ACTIONS`)
 * with the fixed 9-parameter bind contract carried over from the source app.
 */
async function execute(procName, args) {
  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    // Use bind values so request data is never added directly to the call.
    const sql = `
      BEGIN
        ${procName}(
          :pActionCode, :pCompanyNum, :pViewName, :pClientIP, :pJsonReq, :pNotes,
          :oCode, :oMessage, :oJsonResp
        );
      END;
    `;

    const binds = {
      pActionCode: { dir: oracledb.BIND_IN, type: oracledb.STRING, val: fixNullString(args.actionCode), maxSize: 100 },
      pCompanyNum: { dir: oracledb.BIND_IN, type: oracledb.STRING, val: fixNullString(args.companyNum), maxSize: 3 },
      pViewName: { dir: oracledb.BIND_IN, type: oracledb.STRING, val: fixNullString(args.viewName), maxSize: 100 },
      pClientIP: { dir: oracledb.BIND_IN, type: oracledb.STRING, val: fixNullString(args.clientIP), maxSize: 50 },
      pJsonReq: { dir: oracledb.BIND_IN, type: oracledb.DB_TYPE_CLOB, val: fixNullString(args.jsonReq) },
      pNotes: { dir: oracledb.BIND_IN, type: oracledb.DB_TYPE_CLOB, val: fixNullString(args.notes) },
      oCode: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      oMessage: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 4000 },
      oJsonResp: { dir: oracledb.BIND_OUT, type: oracledb.DB_TYPE_CLOB }
    };

    const result = await connection.execute(sql, binds);
    const output = await readLob(result.outBinds.oJsonResp);

    return {
      output: fixNullString(output),
      oCode: fixNullString(result.outBinds.oCode),
      oMessage: fixNullString(result.outBinds.oMessage)
    };
  } finally {
    await connection.close();
  }
}

async function testConnection() {
  const pool = getPool();
  const connection = await pool.getConnection();
  try {
    await connection.execute('SELECT 1 FROM DUAL');
    return true;
  } finally {
    await connection.close();
  }
}

module.exports = { connectDB, getPool, execute, readLob, testConnection };
