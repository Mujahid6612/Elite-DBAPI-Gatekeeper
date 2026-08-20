'use strict';

/**
 * UNIT TEST — LOG_LEVEL=silent suppresses everything.
 *
 * config/env.js freezes its value at load, so the threshold is exercised in its
 * own process (node --test gives each file one).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_LEVEL = 'silent';

const envConfig = require('../../config/env');
const appLogger = require('../../utils/appLogger');

test('the silent override took effect', () => {
  assert.equal(envConfig.logLevel, 'silent');
});

test('no level produces output when LOG_LEVEL=silent', () => {
  const captured = [];
  const originals = { log: console.log, error: console.error };
  console.log = (line) => captured.push(line);
  console.error = (line) => captured.push(line);
  try {
    appLogger.error('e');
    appLogger.warn('w');
    appLogger.info('i');
    appLogger.debug('d');
  } finally {
    console.log = originals.log;
    console.error = originals.error;
  }
  assert.deepEqual(captured, []);
});
