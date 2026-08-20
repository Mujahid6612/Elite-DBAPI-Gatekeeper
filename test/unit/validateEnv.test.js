'use strict';

/**
 * UNIT TEST — config/validateEnv.js (Phase 2, CQ-21 / CQ-45).
 *
 * envConfig is frozen at load, so each scenario runs in a child process with a
 * controlled environment.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '..', '..');
const START = '__RESULT_START__';
const END = '__RESULT_END__';

const VALID = {
  PORT: '5000',
  STRING_RESPONSE_MODE: 'webapi',
  EVENT_LOG_FALLBACK: 'stderr',
  LOG_LEVEL: 'info',
  ORACLE_USER: 'u',
  ORACLE_PASSWORD: 'p',
  ORACLE_CONNECTION: 'db',
  EXPOSE_ERRORS: 'false',
  BODY_LIMIT: '2mb'
};

/** Runs validateEnv in a child process and reports what happened. */
function runValidation(overrides = {}) {
  const script =
    "const v = require('./config/validateEnv');" +
    'let result;' +
    'try { v.validateEnv(); result = { ok: true, problems: [] }; }' +
    'catch (e) { result = { ok: false, name: e.name, message: e.message, problems: v.collectProblems() }; }' +
    `process.stdout.write('${START}' + JSON.stringify(result) + '${END}')`;

  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...VALID, ...overrides }
  });
  const output = `${child.stdout || ''}${child.stderr || ''}`;
  const start = output.indexOf(START);
  const end = output.indexOf(END);
  assert.ok(start !== -1, `no framed output:\n${output}`);
  return { result: JSON.parse(output.slice(start + START.length, end)), stdout: output };
}

test('a fully valid environment passes', () => {
  const { result } = runValidation();
  assert.equal(result.ok, true, `unexpected problems: ${JSON.stringify(result.problems)}`);
});

test('an unparseable or out-of-range PORT is rejected', () => {
  // NOTE: '' is absent deliberately - config/env.js treats it as unset and defaults to 5000.
  // '1.5' is also absent: config/env.js parses with parseInt, which truncates it to the
  // valid port 1. That truncation is pre-existing behavior and out of scope for Phase 2.
  for (const port of ['abc', '0', '70000', '-1']) {
    const { result } = runValidation({ PORT: port });
    assert.equal(result.ok, false, `PORT=${port} should be rejected`);
    assert.ok(
      result.problems.some((p) => p.startsWith('PORT')),
      `PORT=${port}`
    );
  }
});

test('an unset PORT falls back to the 5000 default and is accepted', () => {
  // config/env.js applies `process.env.PORT || '5000'`, so unset is valid.
  const environment = { ...VALID };
  delete environment.PORT;
  const script =
    "const v=require('./config/validateEnv');" +
    "try { v.validateEnv(); process.stdout.write('OK') } catch (e) { process.stdout.write('FAIL:'+e.message) }";
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...environment }
  });
  assert.ok(output.includes('OK'), output);
});

test('unknown enum values are rejected with the allowed set named', () => {
  const mode = runValidation({ STRING_RESPONSE_MODE: 'raww' });
  assert.equal(mode.result.ok, false);
  assert.ok(mode.result.message.includes('webapi | raw'));

  const fallback = runValidation({ EVENT_LOG_FALLBACK: 'console' });
  assert.equal(fallback.result.ok, false);
  assert.ok(fallback.result.message.includes('stderr | stdout'));

  const level = runValidation({ LOG_LEVEL: 'verbose' });
  assert.equal(level.result.ok, false);
  assert.ok(level.result.message.includes('silent | error | warn | info | debug'));
});

test('valid enum values in mixed case and with padding are accepted', () => {
  const { result } = runValidation({ STRING_RESPONSE_MODE: '  RAW  ', LOG_LEVEL: 'DEBUG' });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
});

test('each missing Oracle credential is reported by name', () => {
  for (const key of ['ORACLE_USER', 'ORACLE_PASSWORD', 'ORACLE_CONNECTION']) {
    const { result } = runValidation({ [key]: '' });
    assert.equal(result.ok, false, `${key} should be required`);
    assert.ok(
      result.problems.some((p) => p.startsWith(key)),
      `${key} not named in: ${result.problems}`
    );
  }
});

test('whitespace-only Oracle credentials are treated as missing', () => {
  const { result } = runValidation({ ORACLE_PASSWORD: '   ' });
  assert.equal(result.ok, false);
});

test('all problems are aggregated into one error rather than reported one at a time', () => {
  const { result } = runValidation({
    PORT: 'abc',
    STRING_RESPONSE_MODE: 'nope',
    EVENT_LOG_FALLBACK: 'nope',
    LOG_LEVEL: 'nope',
    ORACLE_USER: '',
    ORACLE_PASSWORD: '',
    ORACLE_CONNECTION: ''
  });

  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 7, `expected 7 problems, got: ${JSON.stringify(result.problems)}`);
  assert.equal(result.name, 'ConfigurationError', 'tagged so startup can print it readably');
  assert.ok(result.message.startsWith('Invalid environment configuration:\n'));
});

test('BODY_LIMIT accepts byte counts with and without a unit suffix', () => {
  for (const limit of ['2mb', '100kb', '1048576', '1.5mb', '512b', '1GB']) {
    const { result } = runValidation({ BODY_LIMIT: limit });
    assert.equal(result.ok, true, `BODY_LIMIT=${limit} should be valid: ${JSON.stringify(result.problems)}`);
  }
});

test('BODY_LIMIT rejects values the bytes parser cannot read', () => {
  // NOTE: '' is absent deliberately - config/env.js treats it as unset and defaults to '2mb'.
  for (const limit of ['plenty', '2 megabytes', 'mb', '2mbb', '-1mb']) {
    const { result } = runValidation({ BODY_LIMIT: limit });
    assert.equal(result.ok, false, `BODY_LIMIT=${limit} should be rejected`);
    assert.ok(
      result.problems.some((p) => p.startsWith('BODY_LIMIT')),
      `BODY_LIMIT=${limit}`
    );
  }
});

test('CQ-45: enabling EXPOSE_ERRORS emits a startup warning but still validates', () => {
  const { result, stdout } = runValidation({ EXPOSE_ERRORS: 'true' });
  assert.equal(result.ok, true, 'the warning must not block startup');
  assert.ok(stdout.includes('EXPOSE_ERRORS is enabled'), `warning not emitted:\n${stdout}`);
  assert.ok(stdout.includes('WARN'));
});

test('EXPOSE_ERRORS disabled produces no warning', () => {
  const { stdout } = runValidation({ EXPOSE_ERRORS: 'false' });
  assert.equal(stdout.includes('EXPOSE_ERRORS is enabled'), false);
});
