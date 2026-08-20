'use strict';

/**
 * UNIT TEST — utils/appLogger.js (added in Phase 2, CQ-24).
 *
 * Unlike test/characterization/, these cover newly written code, so they may be
 * edited freely as that code evolves.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const appLogger = require('../../utils/appLogger');

/** Captures console output for the duration of `run`. */
function capture(run) {
  const lines = { out: [], err: [] };
  const originals = { log: console.log, error: console.error };
  console.log = (line) => lines.out.push(line);
  console.error = (line) => lines.err.push(line);
  try {
    run();
  } finally {
    console.log = originals.log;
    console.error = originals.error;
  }
  return lines;
}

test('errors and warnings go to stderr; info and debug go to stdout', () => {
  const lines = capture(() => {
    appLogger.error('an error');
    appLogger.warn('a warning');
    appLogger.info('some info');
  });

  assert.equal(lines.err.length, 2, 'error + warn belong on stderr');
  assert.equal(lines.out.length, 1, 'info belongs on stdout');
  assert.match(lines.err[0], /ERROR an error$/);
  assert.match(lines.err[1], /WARN a warning$/);
  assert.match(lines.out[0], /INFO some info$/);
});

test('every line is prefixed with an ISO-8601 timestamp and an upper-case level', () => {
  const lines = capture(() => appLogger.info('hello'));
  assert.match(lines.out[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO hello$/);
});

test('metadata is appended as JSON', () => {
  const lines = capture(() => appLogger.error('failed', { method: 'GET', path: '/x' }));
  assert.equal(lines.err[0].endsWith('ERROR failed {"method":"GET","path":"/x"}'), true);
});

test('empty, null and undefined metadata add nothing', () => {
  const lines = capture(() => {
    appLogger.info('a', undefined);
    appLogger.info('b', null);
    appLogger.info('c', {});
  });
  for (const line of lines.out) assert.equal(/[{}]/.test(line), false, `unexpected braces: ${line}`);
});

test('Error values in metadata are unwrapped rather than serialized as {}', () => {
  const lines = capture(() => appLogger.error('boom', { cause: new TypeError('inner') }));
  assert.match(lines.err[0], /"name":"TypeError"/);
  assert.match(lines.err[0], /"message":"inner"/);
  assert.match(lines.err[0], /"stack":"/);
});

test('circular metadata does not throw', () => {
  const circular = { name: 'root' };
  circular.self = circular;

  const lines = capture(() => appLogger.error('cyclic', circular));
  assert.equal(lines.err.length, 1);
  assert.match(lines.err[0], /\[Circular\]/);
});

test('BigInt metadata does not throw', () => {
  const lines = capture(() => appLogger.info('big', { value: 10n }));
  assert.match(lines.out[0], /"value":"10"/);
});

test('the level threshold filters lower-priority output', () => {
  // envConfig is frozen at load, so exercise the exported ordering directly.
  assert.deepEqual(appLogger.LEVELS, { silent: 0, error: 1, warn: 2, info: 3, debug: 4 });
  // Default threshold is 'info', so debug is suppressed but info is not.
  const lines = capture(() => {
    appLogger.debug('suppressed');
    appLogger.info('emitted');
  });
  assert.equal(lines.out.length, 1);
  assert.match(lines.out[0], /emitted/);
});
