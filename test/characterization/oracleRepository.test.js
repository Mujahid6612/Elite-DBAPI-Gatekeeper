'use strict';

/**
 * CHARACTERIZATION TEST — repositories/oracleRepository.js.
 *
 * Pins the generated anonymous PL/SQL block and the full 9-parameter bind
 * descriptor (names, order, directions, types, maxSize). CQ-11 extracts this
 * contract into a shared descriptor and must not alter a single value.
 * The pool is faked via oracledb.createPool, so no database is contacted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const oracledb = require('oracledb');
const oracleRepository = require('../../repositories/oracleRepository');

/** Installs a fake pool through connectDB(), capturing every execute() call. */
async function withFakePool(outBinds, run) {
  const calls = [];
  const closed = { connections: 0 };
  const originalCreatePool = oracledb.createPool;

  oracledb.createPool = async () => ({
    getConnection: async () => ({
      execute: async (sql, binds) => {
        calls.push({ sql, binds });
        return { outBinds };
      },
      close: async () => {
        closed.connections += 1;
      }
    })
  });

  try {
    await oracleRepository.connectDB();
    await run(calls, closed);
  } finally {
    oracledb.createPool = originalCreatePool;
  }
}

const args = {
  actionCode: 'ACT',
  companyNum: '101',
  viewName: 'VIEW',
  clientIP: '10.0.0.1',
  jsonReq: '{"a":1}',
  notes: 'NOTE'
};

test('getPool throws a clear error before connectDB has run', () => {
  // Needs a pristine module instance, so assert it in a child process: once any
  // other test in this file calls connectDB(), the module-level pool stays set.
  const { execFileSync } = require('child_process');
  const script =
    "try { require('./repositories/oracleRepository').getPool(); console.log('NO-THROW'); }" +
    ' catch (e) { console.log(e.message); }';
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: require('path').join(__dirname, '..', '..'),
    encoding: 'utf8'
  });
  assert.ok(output.includes('Oracle pool has not been initialized.'), `unexpected output: ${output}`);
});

test('generates the exact anonymous PL/SQL block with the 9 positional binds', async () => {
  await withFakePool({ oJsonResp: 'R', oCode: 1, oMessage: 'M' }, async (calls) => {
    await oracleRepository.execute('REQUEST_HANDLER.ACTIONS', args);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].sql,
      `
      BEGIN
        REQUEST_HANDLER.ACTIONS(
          :pActionCode, :pCompanyNum, :pViewName, :pClientIP, :pJsonReq, :pNotes,
          :oCode, :oMessage, :oJsonResp
        );
      END;
    `
    );
  });
});

test('bind descriptor: names, order, directions, types and sizes', async () => {
  await withFakePool({ oJsonResp: '', oCode: 0, oMessage: '' }, async (calls) => {
    await oracleRepository.execute('P', args);
    const binds = calls[0].binds;

    assert.deepEqual(
      Object.keys(binds),
      ['pActionCode', 'pCompanyNum', 'pViewName', 'pClientIP', 'pJsonReq', 'pNotes', 'oCode', 'oMessage', 'oJsonResp'],
      'bind order is part of the stored-procedure contract'
    );

    assert.deepEqual(binds.pActionCode, { dir: oracledb.BIND_IN, type: oracledb.STRING, val: 'ACT', maxSize: 100 });
    assert.deepEqual(binds.pCompanyNum, { dir: oracledb.BIND_IN, type: oracledb.STRING, val: '101', maxSize: 3 });
    assert.deepEqual(binds.pViewName, { dir: oracledb.BIND_IN, type: oracledb.STRING, val: 'VIEW', maxSize: 100 });
    assert.deepEqual(binds.pClientIP, { dir: oracledb.BIND_IN, type: oracledb.STRING, val: '10.0.0.1', maxSize: 50 });
    assert.deepEqual(binds.pJsonReq, { dir: oracledb.BIND_IN, type: oracledb.DB_TYPE_CLOB, val: '{"a":1}' });
    assert.deepEqual(binds.pNotes, { dir: oracledb.BIND_IN, type: oracledb.DB_TYPE_CLOB, val: 'NOTE' });
    assert.deepEqual(binds.oCode, { dir: oracledb.BIND_OUT, type: oracledb.NUMBER });
    assert.deepEqual(binds.oMessage, { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 4000 });
    assert.deepEqual(binds.oJsonResp, { dir: oracledb.BIND_OUT, type: oracledb.DB_TYPE_CLOB });
  });
});

test('null and missing args are bound as empty strings, never as null', async () => {
  await withFakePool({ oJsonResp: '', oCode: 0, oMessage: '' }, async (calls) => {
    await oracleRepository.execute('P', {});
    const binds = calls[0].binds;
    for (const key of ['pActionCode', 'pCompanyNum', 'pViewName', 'pClientIP', 'pJsonReq', 'pNotes']) {
      assert.equal(binds[key].val, '', `${key} must bind '' rather than undefined`);
    }
  });
});

test('the procedure name is interpolated into the SQL text, not bound', async () => {
  await withFakePool({ oJsonResp: '', oCode: 0, oMessage: '' }, async (calls) => {
    await oracleRepository.execute('OTHER_PKG.OTHER_PROC', args);
    assert.ok(calls[0].sql.includes('OTHER_PKG.OTHER_PROC('));
    assert.equal('procName' in calls[0].binds, false);
  });
});

test('the connection is always closed, including when execute rejects', async () => {
  const closed = { connections: 0 };
  const originalCreatePool = oracledb.createPool;
  oracledb.createPool = async () => ({
    getConnection: async () => ({
      execute: async () => {
        throw new Error('ORA-00001: boom');
      },
      close: async () => {
        closed.connections += 1;
      }
    })
  });
  try {
    await oracleRepository.connectDB();
    await assert.rejects(() => oracleRepository.execute('P', args), { message: 'ORA-00001: boom' });
    assert.equal(closed.connections, 1, 'finally block must release the connection');
  } finally {
    oracledb.createPool = originalCreatePool;
  }
});

test('result mapping: oJsonResp becomes output, oCode/oMessage are stringified', async () => {
  await withFakePool({ oJsonResp: '  {"ok":1}  ', oCode: 42, oMessage: '  fine  ' }, async () => {
    const result = await oracleRepository.execute('P', args);
    // fixNullString trims every returned field.
    assert.deepEqual(result, { output: '{"ok":1}', oCode: '42', oMessage: 'fine' });
  });
});

test('readLob handles strings, buffers, getData() lobs, streams and null', async () => {
  assert.equal(await oracleRepository.readLob(null), '');
  assert.equal(await oracleRepository.readLob(undefined), '');
  assert.equal(await oracleRepository.readLob('plain'), 'plain');
  assert.equal(await oracleRepository.readLob(Buffer.from('buffered', 'utf8')), 'buffered');
  assert.equal(await oracleRepository.readLob({ getData: async () => 'from-lob' }), 'from-lob');
  assert.equal(await oracleRepository.readLob(42), '42');

  const { Readable } = require('stream');
  assert.equal(await oracleRepository.readLob(Readable.from(['a', 'b'])), 'ab');
});

test('readLob propagates stream errors', async () => {
  const { Readable } = require('stream');
  const failing = new Readable({
    read() {
      this.destroy(new Error('lob stream failed'));
    }
  });
  await assert.rejects(() => oracleRepository.readLob(failing), { message: 'lob stream failed' });
});

test('initializeOracleClient is a no-op in Thin mode (CQ-01 regression guard)', () => {
  // ORACLE_THICK_MODE is false in the test environment, so this must not attempt to
  // load any Oracle Client library. Before CQ-01 this ran unconditionally at module
  // load with a hardcoded Windows path and threw NJS-045 on every other platform.
  assert.doesNotThrow(() => oracleRepository.initializeOracleClient());
});
