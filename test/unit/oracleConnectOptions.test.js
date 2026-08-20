'use strict';

/**
 * REGRESSION TEST — CQ-40 (Phase 3).
 *
 * connectDB() used to read ORACLE_USER / ORACLE_PASSWORD / ORACLE_CONNECTION straight
 * from process.env, and passed `configDir: process.env.TNS_ADMIN` after writing that
 * same variable two lines earlier. Those reads now come from config/env.js.
 *
 * This asserts the exact option object handed to oracledb.createPool in all four
 * combinations of (ORACLE_CONFIG_DIR set/unset x TNS_ADMIN set/unset), which is the
 * evidence that consolidating the reads changed nothing.
 *
 * `configDir: undefined` is equivalent to the previous `process.env.TNS_ADMIN` read:
 * node-oracledb resolves it internally as `options.configDir || process.env.TNS_ADMIN
 * || ''`, so an empty string and undefined follow the same path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '..', '..');
const START = '__POOL_START__';
const END = '__POOL_END__';

const BASE = {
  ORACLE_USER: 'scott',
  ORACLE_PASSWORD: 'tiger',
  ORACLE_CONNECTION: 'ORCLPDB',
  ORACLE_THICK_MODE: 'false'
};

/** Stubs oracledb.createPool in a child process and reports the options it received. */
function captureCreatePoolOptions(overrides) {
  const script =
    "const oracledb = require('oracledb');" +
    'let captured = null;' +
    'oracledb.createPool = async (options) => { captured = options; return {}; };' +
    "const repo = require('./repositories/oracleRepository');" +
    'repo.connectDB().then(() => {' +
    `  process.stdout.write('${START}' + JSON.stringify({` +
    '    options: captured,' +
    "    tnsAdminAfter: process.env.TNS_ADMIN === undefined ? '<unset>' : process.env.TNS_ADMIN" +
    `  }) + '${END}');` +
    '});';

  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...BASE, ...overrides }
  });
  const output = `${child.stdout || ''}${child.stderr || ''}`;
  const start = output.indexOf(START);
  assert.ok(start !== -1, `child produced no framed output:\n${output}`);
  return JSON.parse(output.slice(start + START.length, output.indexOf(END)));
}

test('credentials are taken from config/env.js and passed through unchanged', () => {
  const { options } = captureCreatePoolOptions({ ORACLE_CONFIG_DIR: '/a', TNS_ADMIN: '/b' });
  assert.equal(options.user, 'scott');
  assert.equal(options.password, 'tiger');
  assert.equal(options.connectString, 'ORCLPDB');
});

test('ORACLE_CONFIG_DIR wins over TNS_ADMIN and is exported back to process.env', () => {
  const result = captureCreatePoolOptions({ ORACLE_CONFIG_DIR: '/a', TNS_ADMIN: '/b' });
  assert.equal(result.options.configDir, '/a');
  assert.equal(result.tnsAdminAfter, '/a', 'the Oracle client still reads TNS_ADMIN out-of-band');
});

test('ORACLE_CONFIG_DIR alone is used', () => {
  const result = captureCreatePoolOptions({ ORACLE_CONFIG_DIR: '/a', TNS_ADMIN: '' });
  assert.equal(result.options.configDir, '/a');
  assert.equal(result.tnsAdminAfter, '/a');
});

test('TNS_ADMIN alone is used as the fallback', () => {
  const result = captureCreatePoolOptions({ ORACLE_CONFIG_DIR: '', TNS_ADMIN: '/b' });
  assert.equal(result.options.configDir, '/b');
  assert.equal(result.tnsAdminAfter, '/b');
});

test('with neither set, configDir is undefined and TNS_ADMIN is left untouched', () => {
  const result = captureCreatePoolOptions({ ORACLE_CONFIG_DIR: '', TNS_ADMIN: '' });
  assert.equal(result.options.configDir, undefined);
  assert.equal(result.tnsAdminAfter, '', 'an empty TNS_ADMIN must not be overwritten with a value');
});

test('the option set is exactly these four keys — no stray properties', () => {
  const { options } = captureCreatePoolOptions({ ORACLE_CONFIG_DIR: '/a', TNS_ADMIN: '/b' });
  assert.deepEqual(Object.keys(options).sort(), ['configDir', 'connectString', 'password', 'user']);
});
