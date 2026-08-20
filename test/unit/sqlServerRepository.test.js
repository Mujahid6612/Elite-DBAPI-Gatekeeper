'use strict';

/**
 * UNIT TEST — repositories/sqlServerRepository.js (Phase 5, CQ-11).
 *
 * This dormant driver had no coverage at all: `mssql` is an optional peer dependency
 * and is not installed, so nothing exercised it. Since CQ-11 rewrote its parameter
 * binding to run off the shared contract, it needs a test that proves the resulting
 * calls match the hand-written originals exactly.
 *
 * `mssql` is faked by intercepting Module._load, so no driver install is required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const MAX = Symbol('MAX');

/** Installs a fake `mssql` for the duration of `run` and records every call. */
async function withFakeMssql(run, { executeResult } = {}) {
  const calls = { inputs: [], outputs: [], executed: [], closed: 0, connected: [] };

  const sql = {
    MAX,
    VarChar: (size) => ({ type: 'VarChar', size }),
    NVarChar: (size) => ({ type: 'NVarChar', size }),
    Int: { type: 'Int' },
    connect: async (connectionString) => {
      calls.connected.push(connectionString);
      return {
        request: () => ({
          input: (name, type, value) => calls.inputs.push({ name, type, value }),
          output: (name, type) => calls.outputs.push({ name, type }),
          execute: async (procName) => {
            calls.executed.push(procName);
            return executeResult || { output: { oJsonResp: 'RESP', oCode: 7, oMessage: 'MSG' } };
          }
        }),
        close: async () => {
          calls.closed += 1;
        }
      };
    }
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'mssql') return sql;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    // Pools are cached for the lifetime of the module (CQ-31), so clear them first
    // or one test's pool would be reused by the next with a stale fake attached.
    await require('../../repositories/sqlServerRepository').closeAllPools();
    calls.closed = 0;
    await run(calls, sql);
  } finally {
    Module._load = originalLoad;
  }
  return calls;
}

const ARGS = {
  actionCode: 'ACT',
  companyNum: '101',
  viewName: 'VIEW',
  clientIP: '10.0.0.1',
  jsonReq: '{"a":1}',
  notes: 'NOTE'
};

test('input parameters match the original hand-written bindings exactly', async () => {
  const repo = require('../../repositories/sqlServerRepository');
  const calls = await withFakeMssql(async () => {
    await repo.execute('CONN', 'PROC', ARGS);
  });

  assert.deepEqual(calls.inputs, [
    { name: 'pActionCode', type: { type: 'VarChar', size: 100 }, value: 'ACT' },
    { name: 'pCompanyNum', type: { type: 'VarChar', size: 3 }, value: '101' },
    { name: 'pViewName', type: { type: 'VarChar', size: 100 }, value: 'VIEW' },
    { name: 'pClientIP', type: { type: 'VarChar', size: 50 }, value: '10.0.0.1' },
    { name: 'pJsonReq', type: { type: 'NVarChar', size: MAX }, value: '{"a":1}' },
    { name: 'pNotes', type: { type: 'NVarChar', size: MAX }, value: 'NOTE' }
  ]);
});

test('output parameters match the original hand-written bindings exactly', async () => {
  const repo = require('../../repositories/sqlServerRepository');
  const calls = await withFakeMssql(async () => {
    await repo.execute('CONN', 'PROC', ARGS);
  });

  assert.deepEqual(calls.outputs, [
    { name: 'oCode', type: { type: 'Int' } },
    { name: 'oMessage', type: { type: 'VarChar', size: 4000 } },
    { name: 'oJsonResp', type: { type: 'NVarChar', size: MAX } }
  ]);
});

test('the connection string and procedure name are passed through', async () => {
  const repo = require('../../repositories/sqlServerRepository');
  const calls = await withFakeMssql(async () => {
    await repo.execute('Server=x;Database=y', 'REQUEST_HANDLER.ACTIONS', ARGS);
  });

  assert.deepEqual(calls.connected, ['Server=x;Database=y']);
  assert.deepEqual(calls.executed, ['REQUEST_HANDLER.ACTIONS']);
});

test('missing args bind as empty strings, never undefined', async () => {
  const repo = require('../../repositories/sqlServerRepository');
  const calls = await withFakeMssql(async () => {
    await repo.execute('CONN', 'PROC', {});
  });

  for (const input of calls.inputs) {
    assert.equal(input.value, '', `${input.name} must bind ''`);
  }
});

test('the result maps oJsonResp to output and trims every field', async () => {
  const repo = require('../../repositories/sqlServerRepository');
  let result;
  await withFakeMssql(
    async () => {
      result = await repo.execute('CONN', 'PROC', ARGS);
    },
    { executeResult: { output: { oJsonResp: '  BODY  ', oCode: 42, oMessage: '  M  ' } } }
  );

  assert.deepEqual(result, { output: 'BODY', oCode: '42', oMessage: 'M' });
});

test('pools are cached per connection string, not recreated per request (CQ-31)', async () => {
  const repo = require('../../repositories/sqlServerRepository');
  const calls = await withFakeMssql(async () => {
    await repo.execute('CONN-A', 'PROC', ARGS);
    await repo.execute('CONN-A', 'PROC', ARGS);
    await repo.execute('CONN-B', 'PROC', ARGS);
  });

  assert.deepEqual(calls.connected, ['CONN-A', 'CONN-B'], 'one connect per distinct connection string');
  assert.equal(calls.executed.length, 3, 'all three calls still executed');
  assert.equal(calls.closed, 0, 'the pool must NOT be closed per request');
  await repo.closeAllPools();
});

test('concurrent first callers share one in-flight connect', async () => {
  const repo = require('../../repositories/sqlServerRepository');
  const calls = await withFakeMssql(async () => {
    await Promise.all([
      repo.execute('CONN-RACE', 'PROC', ARGS),
      repo.execute('CONN-RACE', 'PROC', ARGS),
      repo.execute('CONN-RACE', 'PROC', ARGS)
    ]);
  });

  assert.deepEqual(calls.connected, ['CONN-RACE'], 'three concurrent calls must not create three pools');
  await repo.closeAllPools();
});

test('a failed connect is evicted so the next call retries', async () => {
  const repo = require('../../repositories/sqlServerRepository');
  let attempts = 0;
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'mssql') {
      return {
        MAX,
        VarChar: (s) => ({ s }),
        NVarChar: (s) => ({ s }),
        Int: {},
        connect: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('ECONNREFUSED');
          return {
            request: () => ({
              input() {},
              output() {},
              execute: async () => ({ output: { oJsonResp: 'OK', oCode: 0, oMessage: '' } })
            }),
            close: async () => {}
          };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    await assert.rejects(() => repo.execute('CONN-FAIL', 'PROC', ARGS), { message: 'ECONNREFUSED' });
    const result = await repo.execute('CONN-FAIL', 'PROC', ARGS);
    assert.equal(result.output, 'OK', 'the retry must succeed rather than replay a cached rejection');
    assert.equal(attempts, 2);
  } finally {
    Module._load = originalLoad;
    await repo.closeAllPools();
  }
});

test('closeAllPools closes every cached pool exactly once', async () => {
  const repo = require('../../repositories/sqlServerRepository');
  const calls = await withFakeMssql(async () => {
    await repo.execute('CONN-1', 'PROC', ARGS);
    await repo.execute('CONN-2', 'PROC', ARGS);
    await repo.closeAllPools();
  });

  assert.equal(calls.closed, 2, 'both pools closed');
  // A second call is a no-op: the cache is already cleared.
  await repo.closeAllPools();
  assert.equal(calls.closed, 2);
});

test('a clear error is raised when the optional mssql package is absent', async () => {
  const repo = require('../../repositories/sqlServerRepository');
  await assert.rejects(() => repo.execute('CONN', 'PROC', ARGS), {
    message: "SQL Server tenants (dbType=1) require the optional 'mssql' package. Run: npm install mssql"
  });
});
