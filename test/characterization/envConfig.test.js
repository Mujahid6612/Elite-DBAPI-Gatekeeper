'use strict';

/**
 * CHARACTERIZATION TEST — config/env.js resolution rules.
 *
 * config/env.js freezes its result at load, so each combination is evaluated in a
 * child process with a controlled environment. The oracleConfigDir cases are the
 * prerequisite for CQ-40: they prove that envConfig.oracleConfigDir and the value
 * oracleRepository currently reads back out of process.env.TNS_ADMIN are the same
 * in all four combinations, so consolidating the reads cannot change behavior.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..', '..');

// dotenv prints a banner to stdout, so child output is framed with sentinels
// rather than parsed by locating the first '{'.
const START = '__CFG_START__';
const END = '__CFG_END__';

function runInChild(expression, env) {
  const script = `process.stdout.write('${START}' + JSON.stringify(${expression}) + '${END}')`;
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env }
  });
  const start = output.indexOf(START);
  const end = output.indexOf(END);
  assert.ok(start !== -1 && end !== -1, `child produced no framed output:\n${output}`);
  return JSON.parse(output.slice(start + START.length, end));
}

/** Loads config/env.js in a child process under `env` and returns the frozen config. */
function loadEnvConfig(env) {
  return runInChild("require('./config/env')", env);
}

test('defaults apply when nothing is set', () => {
  // Every variable asserted below must appear here. Anything omitted is simply absent
  // from the child's environment, which lets dotenv load the DEVELOPER'S OWN .env and
  // silently turns this into a test of that file rather than of the defaults - the
  // boolean cases passed only because the local .env happened to agree with them.
  const config = loadEnvConfig({
    PORT: '',
    STRING_RESPONSE_MODE: '',
    FLIGHTVIEW_URL: '',
    EVENT_LOG_FALLBACK: '',
    TRUST_PROXY: '',
    EXPOSE_ERRORS: '',
    ORACLE_THICK_MODE: ''
  });
  assert.equal(config.port, 5000);
  assert.equal(config.stringResponseMode, 'webapi');
  assert.equal(config.eventLogFallback, 'stderr');
  assert.equal(config.flightViewUrl, 'http://xml.flightview.com/fvEliteLimoPlus/fvxml.exe?');
  assert.equal(config.trustProxy, false);
  assert.equal(config.exposeErrors, false);
  assert.equal(config.oracleThickMode, false);
  assert.equal(config.projectRoot, projectRoot);
});

test('mode strings are trimmed and lower-cased', () => {
  const config = loadEnvConfig({ STRING_RESPONSE_MODE: '  RAW  ', EVENT_LOG_FALLBACK: ' STDOUT ' });
  assert.equal(config.stringResponseMode, 'raw');
  assert.equal(config.eventLogFallback, 'stdout');
});

test('an unparseable PORT silently becomes NaN — pinned as the current behavior (CQ-21)', () => {
  const config = loadEnvConfig({ PORT: 'abc' });
  assert.equal(config.port, null, 'JSON serialises NaN as null');
});

test('toBoolean accepts 1/true/y/yes in any case and rejects everything else', () => {
  for (const value of ['1', 'true', 'TRUE', 'y', 'Y', 'yes', 'YES', ' true ']) {
    assert.equal(loadEnvConfig({ TRUST_PROXY: value }).trustProxy, true, `TRUST_PROXY=${value}`);
  }
  for (const value of ['0', 'false', 'n', 'no', 'off', 'abc', '']) {
    assert.equal(loadEnvConfig({ TRUST_PROXY: value }).trustProxy, false, `TRUST_PROXY=${value}`);
  }
});

test('oracleConfigDir: ORACLE_CONFIG_DIR wins, TNS_ADMIN is the fallback', () => {
  const both = loadEnvConfig({ ORACLE_CONFIG_DIR: '/a', TNS_ADMIN: '/b' });
  assert.equal(both.oracleConfigDir, '/a');

  const onlyConfigDir = loadEnvConfig({ ORACLE_CONFIG_DIR: '/a', TNS_ADMIN: '' });
  assert.equal(onlyConfigDir.oracleConfigDir, '/a');

  const onlyTnsAdmin = loadEnvConfig({ ORACLE_CONFIG_DIR: '', TNS_ADMIN: '/b' });
  assert.equal(onlyTnsAdmin.oracleConfigDir, '/b');

  const neither = loadEnvConfig({ ORACLE_CONFIG_DIR: '', TNS_ADMIN: '' });
  assert.equal(neither.oracleConfigDir, '');
});

test('CQ-40 prerequisite: the TNS_ADMIN write-then-read in connectDB is a no-op', () => {
  // oracleRepository sets process.env.TNS_ADMIN = envConfig.oracleConfigDir and then
  // passes process.env.TNS_ADMIN as configDir. This proves the value it reads back is
  // always envConfig.oracleConfigDir (or the ambient TNS_ADMIN when that is empty),
  // so CQ-40 can drop the round-trip without changing what Oracle receives.
  const combinations = [
    { ORACLE_CONFIG_DIR: '/a', TNS_ADMIN: '/b', expected: '/a' },
    { ORACLE_CONFIG_DIR: '/a', TNS_ADMIN: '', expected: '/a' },
    { ORACLE_CONFIG_DIR: '', TNS_ADMIN: '/b', expected: '/b' },
    { ORACLE_CONFIG_DIR: '', TNS_ADMIN: '', expected: '' }
  ];

  for (const { expected, ...env } of combinations) {
    const result = runInChild(
      "(() => { const c = require('./config/env');" +
        ' if (c.oracleConfigDir) process.env.TNS_ADMIN = c.oracleConfigDir;' +
        " return { cfg: c.oracleConfigDir, readBack: process.env.TNS_ADMIN || '' }; })()",
      env
    );
    assert.equal(result.cfg, expected, `oracleConfigDir for ${JSON.stringify(env)}`);
    assert.equal(result.readBack, expected, `configDir passed to Oracle for ${JSON.stringify(env)}`);
  }
});

test('oracleClientLibDir no longer falls back to TNS_ADMIN (CQ-42)', () => {
  const config = loadEnvConfig({ ORACLE_CLIENT_LIB_DIR: '', TNS_ADMIN: '/network/admin' });
  assert.equal(config.oracleClientLibDir, '', 'an Instant Client dir must never be inferred from a tnsnames.ora dir');

  const explicit = loadEnvConfig({ ORACLE_CLIENT_LIB_DIR: '/opt/instantclient', TNS_ADMIN: '/network/admin' });
  assert.equal(explicit.oracleClientLibDir, '/opt/instantclient');
});
