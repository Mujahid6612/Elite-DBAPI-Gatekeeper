'use strict';

/**
 * UNIT TEST — repositories/mysqlRepository.js (dbType 3).
 *
 * `mysql2/promise` is faked by intercepting Module._load, so no database is needed and the
 * exact statements the repository issues can be asserted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const repositoryPath = path.join(__dirname, '..', '..', 'repositories', 'mysqlRepository.js');

const ARGS = {
  actionCode: 'DRV.S.LOGIN_DRIVER',
  companyNum: '101',
  viewName: 'LOGIN',
  clientIP: '1.2.3.4',
  jsonReq: JSON.stringify({
    JHeader: { Source: 'BRBackend', Target: 'BRAPI' },
    jHeader: { source: 'BackendService' },
    jData: { P_AFFILIATE_NUM: 7, P_APP_NAME: 'driver-ios' }
  }),
  notes: ''
};

const CONNECTION = {
  name: 'BlinkRide MySQL',
  poolKey: 'cs:abc',
  user: 'admin',
  password: 'secret',
  connectString: 'Server=db.example.com;Port=3307;Database=br;SslMode=Required',
  poolMax: 3
};

/** Loads a fresh repository against a fake mysql2 and records everything it is asked to do. */
async function withFakeMysql(run, { rows = [{ response: '{"jHeader":{"responseCode":0}}' }] } = {}) {
  const calls = { pools: [], executed: [], released: 0, ended: 0, queried: [] };

  const fake = {
    createPool: (options) => {
      calls.pools.push(options);
      return {
        getConnection: async () => ({
          execute: async (statement, values) => {
            calls.executed.push({ statement, values });
            return [/SELECT @pjObj/.test(statement.sql) ? rows : []];
          },
          release: () => {
            calls.released += 1;
          }
        }),
        query: async (statement) => {
          calls.queried.push(statement);
          return [[{ 1: 1 }]];
        },
        end: async () => {
          calls.ended += 1;
        }
      };
    }
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'mysql2/promise') return fake;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[repositoryPath];
  try {
    await run(require(repositoryPath), calls);
  } finally {
    Module._load = originalLoad;
    delete require.cache[repositoryPath];
  }
}

test('issues SET @reqObj, CALL, then SELECT @pjObj in that order', async () => {
  await withFakeMysql(async (repo, calls) => {
    await repo.execute(CONNECTION, 'request_handler', ARGS);

    assert.equal(calls.executed.length, 3);
    assert.equal(calls.executed[0].statement.sql, 'SET @reqObj = ?');
    assert.deepEqual(calls.executed[0].values, [ARGS.jsonReq]);
    assert.equal(calls.executed[1].statement.sql, 'CALL request_handler(?, ?, ?, ?, @reqObj, @pjObj)');
    assert.equal(calls.executed[2].statement.sql, 'SELECT @pjObj AS response');
  });
});

test('a request that already has jHeader and JHeader reaches the procedure unchanged', async () => {
  await withFakeMysql(async (repo, calls) => {
    await repo.execute(CONNECTION, 'request_handler', ARGS);
    assert.deepEqual(JSON.parse(calls.executed[0].values[0]), JSON.parse(ARGS.jsonReq));
  });
});

test('a PascalCase request gains the camelCase sections the procedure reads', async () => {
  await withFakeMysql(async (repo, calls) => {
    const jsonReq = JSON.stringify({
      JHeader: { Source: 'AZSPostman', Target: 'BRAPI', accessToken: 'tok', accessKey: 'key' },
      JMetaData: {},
      JData: { P_APP_NAME: 'DriverApp-IOS' }
    });
    await repo.execute(CONNECTION, 'request_handler', { ...ARGS, jsonReq });

    const sent = JSON.parse(calls.executed[0].values[0]);
    assert.equal(sent.jHeader.accessToken, 'tok');
    assert.equal(sent.jHeader.accessKey, 'key');
    assert.equal(sent.jHeader.source, 'AZSPostman');
    assert.equal(sent.jHeader.target, 'BRAPI');
    assert.deepEqual(sent.jData, { P_APP_NAME: 'DriverApp-IOS' });
    assert.deepEqual(sent.jMetaData, {});
    // The originals are still there.
    assert.equal(sent.JHeader.accessToken, 'tok');
  });
});

test('a camelCase jHeader is never overwritten by the PascalCase one', async () => {
  await withFakeMysql(async (repo, calls) => {
    const jsonReq = JSON.stringify({ JHeader: { Source: 'A' }, jHeader: { source: 'B', accessToken: 'mine' } });
    await repo.execute(CONNECTION, 'request_handler', { ...ARGS, jsonReq });

    const sent = JSON.parse(calls.executed[0].values[0]);
    assert.deepEqual(sent.jHeader, { source: 'B', accessToken: 'mine' });
  });
});

test('JData is read whatever its case', async () => {
  await withFakeMysql(async (repo, calls) => {
    const jsonReq = JSON.stringify({
      JHeader: { Source: 'AZSPostman', Target: 'BRAPI', accessToken: 't' },
      JMetaData: {},
      JData: { P_AFFILIATE_NUM: 'NY101', P_APP_NAME: 'DriverApp-IOS' }
    });
    await repo.execute(CONNECTION, 'request_handler', { ...ARGS, jsonReq });
    assert.deepEqual(calls.executed[1].values, ['1.2.3.4', 'NY101', 'DriverApp-IOS', ARGS.actionCode]);
  });
});

test('a body that is not JSON is passed through unchanged', async () => {
  await withFakeMysql(async (repo, calls) => {
    await repo.execute(CONNECTION, 'request_handler', { ...ARGS, jsonReq: 'not json' });
    assert.deepEqual(calls.executed[0].values, ['not json']);
  });
});

test('procedure arguments are clientIP, affiliate, app name and action code', async () => {
  await withFakeMysql(async (repo, calls) => {
    await repo.execute(CONNECTION, 'request_handler', ARGS);
    assert.deepEqual(calls.executed[1].values, ['1.2.3.4', 7, 'driver-ios', 'DRV.S.LOGIN_DRIVER']);
  });
});

test('a request without affiliate or app name passes NULL, as the backend did', async () => {
  await withFakeMysql(async (repo, calls) => {
    await repo.execute(CONNECTION, 'request_handler', { ...ARGS, jsonReq: '{"jData":{}}' });
    assert.deepEqual(calls.executed[1].values, ['1.2.3.4', null, null, 'DRV.S.LOGIN_DRIVER']);
  });
});

test('returns the response text with empty oCode and oMessage, and releases the session', async () => {
  await withFakeMysql(async (repo, calls) => {
    const result = await repo.execute(CONNECTION, 'request_handler', ARGS);
    assert.deepEqual(result, { output: '{"jHeader":{"responseCode":0}}', oCode: '', oMessage: '' });
    assert.equal(calls.released, 1);
  });
});

test('a JSON-typed variable that arrives already parsed is re-serialised', async () => {
  await withFakeMysql(
    async (repo) => {
      const result = await repo.execute(CONNECTION, 'request_handler', ARGS);
      assert.equal(result.output, '{"jHeader":{"responseCode":0}}');
    },
    { rows: [{ response: { jHeader: { responseCode: 0 } } }] }
  );
});

test('a missing response is an error and still releases the session', async () => {
  await withFakeMysql(
    async (repo, calls) => {
      await assert.rejects(repo.execute(CONNECTION, 'request_handler', ARGS), /No response received/);
      assert.equal(calls.released, 1);
    },
    { rows: [{ response: null }] }
  );
});

test('the pool is built from the ADO string and reused for the same credentials', async () => {
  await withFakeMysql(async (repo, calls) => {
    await repo.execute(CONNECTION, 'request_handler', ARGS);
    await repo.execute(CONNECTION, 'request_handler', ARGS);

    assert.equal(calls.pools.length, 1);
    assert.deepEqual(calls.pools[0], {
      host: 'db.example.com',
      port: 3307,
      user: 'admin',
      password: 'secret',
      database: 'br',
      waitForConnections: true,
      connectionLimit: 3,
      queueLimit: 0,
      connectTimeout: 10000,
      ssl: 'Amazon RDS'
    });
  });
});

test('a procedure name that is not an identifier is rejected before any SQL runs', async () => {
  await withFakeMysql(async (repo, calls) => {
    await assert.rejects(repo.execute(CONNECTION, 'x(); DROP TABLE t; --', ARGS), /Invalid MySQL procedure name/);
    assert.equal(calls.executed.length, 0);
  });
});

test('parseTarget reads both ADO and host:port/database spellings', async () => {
  await withFakeMysql(async (repo) => {
    assert.deepEqual(repo.parseTarget('Server=h;Database=d'), { host: 'h', port: 3306, database: 'd', ssl: false });
    assert.deepEqual(repo.parseTarget('db.internal:3310/br'), {
      host: 'db.internal',
      port: 3310,
      database: 'br',
      ssl: false
    });
    assert.equal(repo.parseTarget('Server=h;SslMode=None').ssl, false);
  });
});

test('closeAllPools ends every pool', async () => {
  await withFakeMysql(async (repo, calls) => {
    await repo.execute(CONNECTION, 'request_handler', ARGS);
    await repo.closeAllPools();
    assert.equal(calls.ended, 1);
  });
});

test('dbType 3 is dispatched to the MySQL driver', async () => {
  await withFakeMysql(async (repo, calls) => {
    const dbRepositoryPath = require.resolve('../../repositories/dbRepository');
    delete require.cache[dbRepositoryPath];
    // dbRepository captured the real mysqlRepository at require time, so load it after the fake.
    const { processDbRequest } = require(dbRepositoryPath);
    const result = await processDbRequest({
      connection: CONNECTION,
      dbType: '3',
      procName: 'request_handler',
      ...ARGS
    });
    assert.equal(result.output, '{"jHeader":{"responseCode":0}}');
    assert.equal(calls.executed.length, 3);
    delete require.cache[dbRepositoryPath];
  });
});
