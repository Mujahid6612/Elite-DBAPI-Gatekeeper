'use strict';

/**
 * UNIT TEST — config/tenantRegistry.js.
 *
 * Guards the three things the JSON migration is FOR:
 *
 *  1. many-to-one — several sources sharing one database block, which is the whole
 *     point of listing `sources` as an array;
 *  2. the three credential sources (encrypted connectionString / envPrefix / default)
 *     and the pool identity that decides whether two blocks share a pool;
 *  3. that an invalid file is rejected at LOAD with every problem at once, rather than
 *     one broken source at a time in production.
 */

// Must precede the config requires: config/env.js FREEZES its values at load, so a
// key set later would not reach the decryption path. This mirrors how the deployment
// works - the passphrase is present before the process starts.
process.env.CONFIG_ENCRYPTION_KEY = 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tenantRegistry = require('../../config/tenantRegistry');
const { encryptString } = require('../../utils/encryption');

const BASE_DEFAULT = { projectName: 'Self', companyNum: '999', whitelistedIPs: '*', logType: 1, logPath: '~/Log' };

/** Writes a tenant configuration to a throwaway file and returns its path. */
function writeConfig(document) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbgk-tenants-'));
  const file = path.join(dir, 'tenants.json');
  fs.writeFileSync(file, JSON.stringify({ default: BASE_DEFAULT, ...document }), 'utf8');
  return file;
}

const THREE_APPS_ONE_DB = {
  databases: [
    {
      projectName: 'elite_main',
      sources: ['EliteNativeApp', 'EliteIdWebApp', 'EliteWebsite'],
      target: 'DBAPI',
      companyNum: '101',
      procName: 'REQUEST_HANDLER.ACTIONS',
      dbType: 2,
      logType: 0,
      logPath: '~/Log',
      whitelistedIPs: '*'
    }
  ]
};

test('three sources on one block all reach the SAME database and settings', () => {
  const registry = tenantRegistry.readTenantRegistry(writeConfig(THREE_APPS_ONE_DB));

  const blocks = ['EliteNativeApp', 'EliteIdWebApp', 'EliteWebsite'].map((source) =>
    tenantRegistry.resolveTenant(source, 'DBAPI', registry)
  );

  assert.ok(blocks.every(Boolean), 'every listed source must route');
  assert.equal(blocks[0], blocks[1], 'same object, not merely equal values');
  assert.equal(blocks[1], blocks[2]);
  assert.deepEqual(
    blocks.map((b) => `${b.companyNum}/${b.procName}`),
    ['101/REQUEST_HANDLER.ACTIONS', '101/REQUEST_HANDLER.ACTIONS', '101/REQUEST_HANDLER.ACTIONS']
  );
});

test('one-to-one and many-to-one coexist in the same file', () => {
  const registry = tenantRegistry.readTenantRegistry(
    writeConfig({
      databases: [
        { projectName: 'shared', sources: ['AppA', 'AppB'], target: 'DBAPI', companyNum: '101' },
        { projectName: 'private', sources: ['AppC'], target: 'DBAPI', companyNum: '102' }
      ]
    })
  );

  assert.equal(tenantRegistry.resolveTenant('AppA', 'DBAPI', registry).projectName, 'shared');
  assert.equal(tenantRegistry.resolveTenant('AppB', 'DBAPI', registry).projectName, 'shared');
  assert.equal(tenantRegistry.resolveTenant('AppC', 'DBAPI', registry).projectName, 'private');
  assert.equal(tenantRegistry.resolveTenant('AppC', 'DBAPI', registry).companyNum, '102');
});

test('the same source may serve different targets', () => {
  const registry = tenantRegistry.readTenantRegistry(
    writeConfig({
      databases: [
        { projectName: 'main', sources: ['AppA'], target: 'DBAPI', companyNum: '101' },
        { projectName: 'reporting', sources: ['AppA'], target: 'REPORTING', companyNum: '101' }
      ]
    })
  );

  assert.equal(tenantRegistry.resolveTenant('AppA', 'DBAPI', registry).projectName, 'main');
  assert.equal(tenantRegistry.resolveTenant('AppA', 'REPORTING', registry).projectName, 'reporting');
});

test('an unconfigured pair resolves to null rather than to some default', () => {
  const registry = tenantRegistry.readTenantRegistry(writeConfig(THREE_APPS_ONE_DB));

  assert.equal(tenantRegistry.resolveTenant('Unknown', 'DBAPI', registry), null);
  assert.equal(tenantRegistry.resolveTenant('EliteNativeApp', 'REPORTING', registry), null);
  assert.equal(tenantRegistry.resolveTenant('', '', registry), null);
});

test('matching ignores case and surrounding whitespace', () => {
  const registry = tenantRegistry.readTenantRegistry(writeConfig(THREE_APPS_ONE_DB));

  for (const [source, target] of [
    ['elitenativeapp', 'dbapi'],
    ['ELITENATIVEAPP', 'DBAPI'],
    ['  EliteNativeApp  ', ' DBAPI ']
  ]) {
    assert.equal(
      tenantRegistry.resolveTenant(source, target, registry).projectName,
      'elite_main',
      `${source}/${target}`
    );
  }
});

test('the default block is always available, for pre-parse logging and the IP gate', () => {
  const registry = tenantRegistry.readTenantRegistry(writeConfig(THREE_APPS_ONE_DB));
  const fallback = tenantRegistry.defaultTenant(registry);

  assert.equal(fallback.companyNum, '999');
  assert.equal(fallback.logType, 1);
  assert.equal(fallback.isIPWhitelisted('1.2.3.4', true), true, 'the gate runs against this block');
});

/* ─────────────────────────  credentials and pool identity  ───────────────────────── */

test('an encrypted connectionString is decrypted and split into Oracle credentials', () => {
  const cipherText = encryptString('Data Source=ELDevWan;user id=SCOTT;password=TIGER;', 'test-key');
  const registry = tenantRegistry.readTenantRegistry(
    writeConfig({
      databases: [{ projectName: 'enc', sources: ['AppA'], target: 'DBAPI', connectionString: cipherText, poolMax: 2 }]
    })
  );

  const connection = tenantRegistry.connectionFor(tenantRegistry.resolveTenant('AppA', 'DBAPI', registry));

  assert.equal(connection.user, 'SCOTT');
  assert.equal(connection.password, 'TIGER');
  assert.equal(connection.connectString, 'ELDevWan', 'Data Source becomes the Oracle connect string');
  assert.equal(connection.poolMax, 2);
});

test('envPrefix reads the three environment variables instead', () => {
  const registry = tenantRegistry.readTenantRegistry(
    writeConfig({ databases: [{ projectName: 'env', sources: ['AppA'], target: 'DBAPI', envPrefix: 'DB_TEST' }] })
  );

  process.env.DB_TEST_USER = 'envuser';
  process.env.DB_TEST_PASSWORD = 'envpass';
  process.env.DB_TEST_CONNECT_STRING = 'ENVCONN';

  const connection = tenantRegistry.connectionFor(tenantRegistry.resolveTenant('AppA', 'DBAPI', registry));
  assert.equal(connection.user, 'envuser');
  assert.equal(connection.connectString, 'ENVCONN');
  assert.equal(connection.poolKey, 'env:DB_TEST');
});

test('a block with neither falls back to the default ORACLE_* variables', () => {
  const registry = tenantRegistry.readTenantRegistry(
    writeConfig({ databases: [{ projectName: 'plain', sources: ['AppA'], target: 'DBAPI' }] })
  );

  process.env.ORACLE_USER = 'oracleuser';
  const connection = tenantRegistry.connectionFor(tenantRegistry.resolveTenant('AppA', 'DBAPI', registry));

  assert.equal(connection.user, 'oracleuser');
  assert.equal(connection.poolKey, '', 'the empty key is what makes it share the default pool');
});

test('blocks with the same credentials share a pool key; different ones do not', () => {
  // Pool identity is credentials, not the block name - otherwise two names for one
  // database would open two pools and double the Oracle sessions held.
  const registry = tenantRegistry.readTenantRegistry(
    writeConfig({
      databases: [
        { projectName: 'a', sources: ['AppA'], target: 'DBAPI', envPrefix: 'DB_SHARED' },
        { projectName: 'b', sources: ['AppB'], target: 'DBAPI', envPrefix: 'DB_SHARED' },
        { projectName: 'c', sources: ['AppC'], target: 'DBAPI', envPrefix: 'DB_OTHER' }
      ]
    })
  );

  const key = (source) => tenantRegistry.connectionFor(tenantRegistry.resolveTenant(source, 'DBAPI', registry)).poolKey;

  assert.equal(key('AppA'), key('AppB'), 'same credentials -> one pool');
  assert.notEqual(key('AppA'), key('AppC'), 'different credentials -> separate pools');
});

/* ────────────────────────────────  validation  ──────────────────────────────── */

test('a block claiming a source another block already serves is rejected', () => {
  const file = writeConfig({
    databases: [
      { projectName: 'first', sources: ['AppA'], target: 'DBAPI' },
      { projectName: 'second', sources: ['appa'], target: 'dbapi' }
    ]
  });

  assert.throws(() => tenantRegistry.readTenantRegistry(file), /already served by "first"/);
});

test('declaring both connectionString and envPrefix is rejected as ambiguous', () => {
  const file = writeConfig({
    databases: [{ projectName: 'x', sources: ['A'], target: 'T', connectionString: 'abc', envPrefix: 'DB_X' }]
  });

  assert.throws(() => tenantRegistry.readTenantRegistry(file), /not both/);
});

test('a misspelled field is reported rather than silently ignored', () => {
  // Every getter returns '' for an absent key, so a typo would otherwise run the block
  // with a default nobody chose - a wrong companyNum reaching the stored procedure.
  const file = writeConfig({
    databases: [{ projectName: 'x', sources: ['A'], target: 'T', procname: 'lowercase.typo' }]
  });

  assert.throws(() => tenantRegistry.readTenantRegistry(file), /unknown field "procname"/);
});

test('every problem is reported together, not one per restart', () => {
  const file = writeConfig({
    databases: [{ projectName: 'x', target: 'T', poolMax: 0, bogus: 1 }, { sources: ['B'] }]
  });

  try {
    tenantRegistry.readTenantRegistry(file);
    assert.fail('should have thrown');
  } catch (error) {
    assert.equal(error.name, 'ConfigurationError');
    assert.match(error.message, /"sources" must list at least one source/);
    assert.match(error.message, /"target" is required/);
    assert.match(error.message, /"poolMax" must be a positive whole number/);
    assert.match(error.message, /unknown field "bogus"/);
  }
});

test('a missing default block is rejected: pre-parse logging would have no tenant', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbgk-tenants-'));
  const file = path.join(dir, 'tenants.json');
  fs.writeFileSync(file, JSON.stringify({ databases: [{ projectName: 'x', sources: ['A'], target: 'T' }] }), 'utf8');

  assert.throws(() => tenantRegistry.readTenantRegistry(file), /"default" block is missing/);
});

test('an empty databases list is rejected: no request could ever be routed', () => {
  assert.throws(
    () => tenantRegistry.readTenantRegistry(writeConfig({ databases: [] })),
    /no request could ever be routed/
  );
});

test('a malformed or absent file fails with a ConfigurationError naming the path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbgk-tenants-'));
  const bad = path.join(dir, 'tenants.json');
  fs.writeFileSync(bad, '{ not json', 'utf8');

  assert.throws(() => tenantRegistry.readTenantRegistry(bad), /is not valid JSON/);
  assert.throws(() => tenantRegistry.readTenantRegistry(path.join(dir, 'absent.json')), /could not be read/);
});

test('the shipped config/tenants.jsonc is valid and serves both real clients', () => {
  // Guards the file that actually ships: a typo here takes every client down.
  const registry = tenantRegistry.readTenantRegistry();

  assert.ok(tenantRegistry.resolveTenant('EliteNativeApp', 'DBAPI', registry), 'EliteApp must route');
  assert.ok(tenantRegistry.resolveTenant('EliteIdWebApp', 'DBAPI', registry), 'EliteID must route');
  assert.equal(tenantRegistry.defaultTenant(registry).companyNum, '999');
});
