'use strict';

/**
 * UNIT TEST — connection release (Phase 6, CQ-28).
 *
 * BEHAVIORAL NOTE: this is the one Phase 6 change with an observable effect. When
 * BOTH execute() and close() fail, the error that now propagates is the execute()
 * error rather than the close() error. On the POST path that error message becomes
 * the HTTP 200 response body, so the body text differs in that rare double-failure
 * case. Every single-failure case is unchanged.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const oracledb = require('oracledb');
const oracleRepository = require('../../repositories/oracleRepository');

const ARGS = { actionCode: 'A', companyNum: '1', viewName: 'V', clientIP: 'ip', jsonReq: '{}', notes: 'N' };

/** Installs a fake pool whose connection fails on execute and/or close. */
async function withPool({ executeError, closeError, outBinds }, run) {
  const state = { closeAttempts: 0 };
  const original = oracledb.createPool;
  oracledb.createPool = async () => ({
    getConnection: async () => ({
      execute: async () => {
        if (executeError) throw executeError;
        return { outBinds: outBinds || { oJsonResp: 'OK', oCode: 0, oMessage: '' } };
      },
      close: async () => {
        state.closeAttempts += 1;
        if (closeError) throw closeError;
      }
    })
  });
  try {
    await oracleRepository.connectDB();
    await run(state);
  } finally {
    oracledb.createPool = original;
  }
}

/** Silences appLogger.warn (stderr) while capturing what it emitted. */
function captureWarnings(run) {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(line);
  return Promise.resolve(run())
    .finally(() => {
      console.error = original;
    })
    .then(() => lines);
}

test('a close failure alone does not fail an otherwise successful call', async () => {
  await withPool({ closeError: new Error('ORA-03113: connection lost') }, async (state) => {
    const lines = await captureWarnings(async () => {
      const result = await oracleRepository.execute('P', ARGS);
      assert.equal(result.output, 'OK', 'the successful result must still be returned');
    });
    assert.equal(state.closeAttempts, 1);
    assert.equal(lines.length, 1, 'the close failure is logged, not swallowed silently');
    assert.match(lines[0], /Failed to close Oracle connection/);
    assert.match(lines[0], /ORA-03113/);
  });
});

test('when BOTH execute and close fail, the execute error is the one that propagates', async () => {
  await withPool(
    {
      executeError: new Error('ORA-06550: PLS-00201 identifier must be declared'),
      closeError: new Error('ORA-03113: end-of-file on communication channel')
    },
    async (state) => {
      await captureWarnings(async () => {
        await assert.rejects(() => oracleRepository.execute('P', ARGS), {
          message: 'ORA-06550: PLS-00201 identifier must be declared'
        });
      });
      assert.equal(state.closeAttempts, 1, 'the connection is still released');
    }
  );
});

test('an execute failure alone propagates unchanged', async () => {
  await withPool({ executeError: new Error('ORA-01017: invalid credential') }, async (state) => {
    await assert.rejects(() => oracleRepository.execute('P', ARGS), { message: 'ORA-01017: invalid credential' });
    assert.equal(state.closeAttempts, 1);
  });
});

test('verifyConnectable also releases quietly', async () => {
  await withPool({ closeError: new Error('close boom') }, async (state) => {
    const lines = await captureWarnings(async () => {
      assert.equal(await oracleRepository.verifyConnectable(), true);
    });
    assert.equal(state.closeAttempts, 1);
    assert.equal(lines.length, 1);
  });
});
