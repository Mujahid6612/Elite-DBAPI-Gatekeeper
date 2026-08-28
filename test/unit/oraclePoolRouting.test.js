'use strict';

/**
 * UNIT TEST — one Oracle pool per routed connection.
 *
 * The point of the whole routing change is that two applications can reach two
 * databases. That only works if the repository builds a SEPARATE pool per set of
 * credentials, and only pays for one pool when two connections share credentials.
 *
 * Both halves are asserted here because getting either wrong is quiet: too few pools
 * sends one app's traffic to the other's database, and too many silently doubles the
 * Oracle sessions the process holds - which on a serverless host is multiplied again
 * by the instance count.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const oracledb = require('oracledb');
const oracleRepository = require('../../repositories/oracleRepository');

const ARGS = { actionCode: 'A', companyNum: '101', viewName: 'V', clientIP: '1.1.1.1', jsonReq: '{}', notes: 'N' };

/** Records every createPool call and hands back a pool that reports which one it is. */
async function withRecordedPools(run) {
  const created = [];
  const original = oracledb.createPool;

  oracledb.createPool = async (options) => {
    created.push(options);
    return {
      getConnection: async () => ({
        execute: async () => ({ outBinds: { oJsonResp: options.connectString, oCode: 0, oMessage: '' } }),
        close: async () => {}
      }),
      close: async () => {}
    };
  };

  try {
    await run(created);
  } finally {
    oracledb.createPool = original;
    await oracleRepository.closePool(0);
  }
}

const connection = (envPrefix, connectString) => ({
  name: envPrefix.toLowerCase(),
  envPrefix,
  user: `${envPrefix}_U`,
  password: `${envPrefix}_P`,
  connectString
});

test('two connections with different credentials get their own pool and their own database', async () => {
  await withRecordedPools(async (created) => {
    const a = await oracleRepository.execute('P', ARGS, connection('DB_ROUTE_A', 'ALPHA'));
    const b = await oracleRepository.execute('P', ARGS, connection('DB_ROUTE_B', 'BETA'));

    assert.equal(created.length, 2, 'one pool per distinct connection');
    assert.deepEqual(
      created.map((options) => options.connectString).sort(),
      ['ALPHA', 'BETA'],
      'each pool targets its own database'
    );
    assert.equal(created[0].user, 'DB_ROUTE_A_U');
    assert.equal(created[1].user, 'DB_ROUTE_B_U');

    // The stub echoes its own connectString, proving each call ran on its own pool.
    assert.equal(a.output, 'ALPHA');
    assert.equal(b.output, 'BETA');
  });
});

test('repeated requests on one connection reuse its pool', async () => {
  await withRecordedPools(async (created) => {
    const route = connection('DB_ROUTE_REUSE', 'GAMMA');
    await oracleRepository.execute('P', ARGS, route);
    await oracleRepository.execute('P', ARGS, route);
    await oracleRepository.execute('P', ARGS, route);

    assert.equal(created.length, 1, 'a pool per REQUEST would exhaust the database session limit');
  });
});

test('two connections sharing an envPrefix share one pool', async () => {
  // Keying on credentials rather than on the connection LABEL. Two names for the same
  // database must not cost two pools.
  await withRecordedPools(async (created) => {
    await oracleRepository.execute('P', ARGS, { name: 'first', envPrefix: 'DB_SHARED', connectString: 'X' });
    await oracleRepository.execute('P', ARGS, { name: 'second', envPrefix: 'DB_SHARED', connectString: 'X' });

    assert.equal(created.length, 1);
  });
});

test('a connection with no envPrefix uses the default pool rather than a duplicate of it', async () => {
  await withRecordedPools(async (created) => {
    await oracleRepository.connectDB();
    assert.equal(created.length, 1, 'the default pool');

    await oracleRepository.execute('P', ARGS, { name: 'elite_main', envPrefix: '' });
    await oracleRepository.execute('P', ARGS, undefined);

    assert.equal(created.length, 1, 'neither call may build a second pool on the same credentials');
  });
});

test('a failed connect is not cached, so the next request retries', async () => {
  const original = oracledb.createPool;
  let attempts = 0;

  oracledb.createPool = async (options) => {
    attempts += 1;
    if (attempts === 1) throw new Error('ORA-12541: TNS:no listener');
    return {
      getConnection: async () => ({
        execute: async () => ({ outBinds: { oJsonResp: options.connectString, oCode: 0, oMessage: '' } }),
        close: async () => {}
      }),
      close: async () => {}
    };
  };

  try {
    const route = connection('DB_ROUTE_FLAKY', 'DELTA');
    await assert.rejects(() => oracleRepository.execute('P', ARGS, route), /ORA-12541/);

    // A transient outage must not poison this connection for the life of the instance.
    const recovered = await oracleRepository.execute('P', ARGS, route);
    assert.equal(recovered.output, 'DELTA');
    assert.equal(attempts, 2);
  } finally {
    oracledb.createPool = original;
    await oracleRepository.closePool(0);
  }
});

test('closePool releases every routed pool, not just the default one', async () => {
  const closed = [];
  const original = oracledb.createPool;

  oracledb.createPool = async (options) => ({
    getConnection: async () => ({
      execute: async () => ({ outBinds: { oJsonResp: '', oCode: 0, oMessage: '' } }),
      close: async () => {}
    }),
    close: async () => closed.push(options.connectString)
  });

  try {
    await oracleRepository.execute('P', ARGS, connection('DB_CLOSE_A', 'EPSILON'));
    await oracleRepository.execute('P', ARGS, connection('DB_CLOSE_B', 'ZETA'));

    await oracleRepository.closePool(0);
    assert.deepEqual(closed.sort(), ['EPSILON', 'ZETA'], 'stranded pools keep their sessions open');
  } finally {
    oracledb.createPool = original;
  }
});
