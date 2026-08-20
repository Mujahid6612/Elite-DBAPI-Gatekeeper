'use strict';

/**
 * CHARACTERIZATION TEST — repositories/dbRepository.js dispatch.
 *
 * Pins which driver each dbType selects and the exact OLE DB rejection message.
 * dbRepository calls oracleRepository.execute / sqlServerRepository.execute as
 * property lookups at call time, so swapping the property is enough to stub them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const dbRepository = require('../../repositories/dbRepository');
const oracleRepository = require('../../repositories/oracleRepository');
const sqlServerRepository = require('../../repositories/sqlServerRepository');

const OLEDB_MESSAGE =
  'OLE DB (dbType=0) has no portable Node.js equivalent and is not used by the supplied config.xml.';

/** Swaps both driver `execute` functions for recorders, restoring them afterwards. */
async function withStubbedDrivers(run) {
  const originals = { oracle: oracleRepository.execute, sqlServer: sqlServerRepository.execute };
  const calls = { oracle: [], sqlServer: [] };
  oracleRepository.execute = async (...args) => {
    calls.oracle.push(args);
    return { output: 'ORACLE' };
  };
  sqlServerRepository.execute = async (...args) => {
    calls.sqlServer.push(args);
    return { output: 'SQL' };
  };
  try {
    await run(calls);
  } finally {
    oracleRepository.execute = originals.oracle;
    sqlServerRepository.execute = originals.sqlServer;
  }
}

const request = (dbType) => ({
  connectionString: 'CONN',
  dbType,
  procName: 'PROC',
  actionCode: 'A',
  companyNum: '101',
  viewName: 'V',
  clientIP: '1.2.3.4',
  jsonReq: '{}',
  notes: 'N'
});

test('dbType=2 dispatches to Oracle without the connection string', async () => {
  await withStubbedDrivers(async (calls) => {
    const result = await dbRepository.processDbRequest(request('2'));
    assert.equal(result.output, 'ORACLE');
    assert.equal(calls.sqlServer.length, 0);
    assert.deepEqual(calls.oracle[0][0], 'PROC');
    // The Oracle driver receives only procName + args: it uses the pooled credentials,
    // never the tenant's decrypted connection string.
    assert.deepEqual(calls.oracle[0][1], {
      actionCode: 'A',
      companyNum: '101',
      viewName: 'V',
      clientIP: '1.2.3.4',
      jsonReq: '{}',
      notes: 'N'
    });
    assert.equal(calls.oracle[0].length, 2);
  });
});

test('dbType=1 dispatches to SQL Server with the connection string first', async () => {
  await withStubbedDrivers(async (calls) => {
    const result = await dbRepository.processDbRequest(request('1'));
    assert.equal(result.output, 'SQL');
    assert.equal(calls.oracle.length, 0);
    assert.equal(calls.sqlServer[0][0], 'CONN');
    assert.equal(calls.sqlServer[0][1], 'PROC');
  });
});

test('dbType=0 and unmapped types are rejected with the OLE DB message', async () => {
  await withStubbedDrivers(async (calls) => {
    for (const dbType of ['0', 0, '', null, undefined, 'abc', '9']) {
      await assert.rejects(
        () => dbRepository.processDbRequest(request(dbType)),
        { message: OLEDB_MESSAGE },
        `dbType=${JSON.stringify(dbType)}`
      );
    }
    assert.equal(calls.oracle.length + calls.sqlServer.length, 0, 'no driver may be reached');
  });
});

test('dbType is coerced through fixNullInt, so numeric and string forms agree', async () => {
  await withStubbedDrivers(async (calls) => {
    await dbRepository.processDbRequest(request(2));
    await dbRepository.processDbRequest(request(' 2 '));
    assert.equal(calls.oracle.length, 2);
  });
});
