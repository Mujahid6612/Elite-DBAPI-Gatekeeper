'use strict';

/**
 * UNIT TEST — services/healthInfoService.js.
 *
 * The behaviour worth guarding is the one routing introduced: with more than one
 * database reachable, a health endpoint that probes only the default pool reports the
 * service UP while a routed database is unreachable. That is the exact failure this
 * endpoint exists to catch, so it is asserted directly.
 *
 * The pre-routing payload shape is also pinned, because monitoring reads it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const healthInfoService = require('../../services/healthInfoService');
const oracleRepository = require('../../repositories/oracleRepository');
const tenantRegistry = require('../../config/tenantRegistry');

const CONNECTIONS = [
  { name: 'elite_main', poolKey: 'env:DB_MAIN', user: 'u', password: 'p', connectString: 'MAIN' },
  { name: 'elite_id', poolKey: 'env:DB_ID', user: 'u', password: 'p', connectString: 'ID' }
];

/** Stubs the registry and the connectivity probe, restoring both afterwards. */
async function withProbes({ connections = CONNECTIONS, healthy = () => true }, run) {
  const originals = {
    allBlocks: tenantRegistry.allBlocks,
    connectionFor: tenantRegistry.connectionFor,
    verify: oracleRepository.verifyConnectableFor
  };

  // Each stub "block" is its own connection descriptor, which keeps the fixture flat.
  tenantRegistry.allBlocks = () => connections;
  tenantRegistry.connectionFor = (block) => block;
  oracleRepository.verifyConnectableFor = async (connection) => {
    if (!healthy(connection)) throw new Error(`ORA-12541: no listener for ${connection.name}`);
    return true;
  };

  try {
    await run();
  } finally {
    tenantRegistry.allBlocks = originals.allBlocks;
    tenantRegistry.connectionFor = originals.connectionFor;
    oracleRepository.verifyConnectableFor = originals.verify;
  }
}

test('every routed database is reported individually', async () => {
  await withProbes({}, async () => {
    const health = await healthInfoService.getHealthInfoService();

    assert.equal(health.databases.length, 2);
    assert.deepEqual(health.databases.map((entry) => entry.name).sort(), ['elite_id', 'elite_main']);
    assert.ok(health.databases.every((entry) => entry.status === 'UP'));
  });
});

test('one routed database down makes the aggregate DOWN and names the culprit', async () => {
  // The regression this exists to prevent: before routing, the endpoint probed only
  // the default pool, so a second database being unreachable read as fully healthy.
  await withProbes({ healthy: (connection) => connection.name !== 'elite_id' }, async () => {
    const health = await healthInfoService.getHealthInfoService();

    assert.equal(health.database.status, 'DOWN', 'a partial outage must not read as UP');
    assert.equal(health.database.connected, false);
    assert.match(health.database.error, /elite_id/);

    const byName = Object.fromEntries(health.databases.map((entry) => [entry.name, entry]));
    assert.equal(byName.elite_main.status, 'UP', 'the healthy one is still reported healthy');
    assert.equal(byName.elite_id.status, 'DOWN');
    assert.match(byName.elite_id.error, /ORA-12541/);
  });
});

test('all databases healthy reports the aggregate UP with no error', async () => {
  await withProbes({}, async () => {
    const health = await healthInfoService.getHealthInfoService();

    assert.equal(health.database.status, 'UP');
    assert.equal(health.database.connected, true);
    assert.equal(health.database.error, null);
  });
});

test('the pre-routing payload shape is preserved for existing monitors', async () => {
  await withProbes({}, async () => {
    const health = await healthInfoService.getHealthInfoService();

    assert.deepEqual(Object.keys(health.database).sort(), ['connected', 'error', 'status']);
    assert.equal(health.application.status, 'UP');
    assert.equal(typeof health.application.pid, 'number');
    assert.equal(typeof health.application.startedAt, 'string');
    assert.equal(typeof health.serverTime, 'string');
  });
});

test('the process is reported UP even when every database is down', async () => {
  // The two are deliberately separate signals: the process is answering this request.
  await withProbes({ healthy: () => false }, async () => {
    const health = await healthInfoService.getHealthInfoService();

    assert.equal(health.application.status, 'UP');
    assert.equal(health.database.status, 'DOWN');
  });
});

test('an unloadable routing map is reported rather than thrown', async () => {
  const original = tenantRegistry.allBlocks;
  tenantRegistry.allBlocks = () => {
    throw new Error('Invalid database routing map');
  };

  try {
    const health = await healthInfoService.getHealthInfoService();

    assert.equal(health.database.status, 'DOWN');
    assert.equal(health.databases[0].name, 'routing-map');
    assert.match(health.databases[0].error, /Invalid database routing map/);
  } finally {
    tenantRegistry.allBlocks = original;
  }
});

test('a probe never throws, so one bad database cannot 500 the endpoint', async () => {
  await withProbes({ healthy: () => false }, async () => {
    await assert.doesNotReject(() => healthInfoService.getHealthInfoService());
  });
});
