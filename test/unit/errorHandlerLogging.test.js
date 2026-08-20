'use strict';

/**
 * UNIT TEST — middleware/errorHandler.js logging (Phase 2, CQ-20).
 *
 * Asserts the side channel was added AND that the response contract is untouched:
 * before this change an unhandled 500 left no trace anywhere.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const errorHandler = require('../../middleware/errorHandler');

function fakeRes() {
  const state = {};
  return {
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(payload) {
      state.payload = payload;
      return this;
    },
    state
  };
}

/** Captures stderr for the duration of `run`. */
function captureStderr(run) {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(line);
  try {
    run();
  } finally {
    console.error = original;
  }
  return lines;
}

test('logs message, name, stack, method and path to stderr', () => {
  const error = new TypeError('kaboom');
  error.stack = 'TypeError: kaboom\n    at somewhere';
  const req = { method: 'POST', originalUrl: '/DBAPI/ProcessRequest' };
  const res = fakeRes();

  const lines = captureStderr(() => errorHandler(error, req, res, () => {}));

  assert.equal(lines.length, 1, 'exactly one log line per unhandled error');
  assert.match(lines[0], /ERROR Unhandled request error/);
  assert.match(lines[0], /"message":"kaboom"/);
  assert.match(lines[0], /"name":"TypeError"/);
  assert.match(lines[0], /"method":"POST"/);
  assert.match(lines[0], /"path":"\/DBAPI\/ProcessRequest"/);
  assert.match(lines[0], /"stack":"TypeError: kaboom/);
});

test('the response body and status are unchanged by the added logging', () => {
  const res = fakeRes();
  captureStderr(() => errorHandler(new Error('x'), { method: 'GET', originalUrl: '/a' }, res, () => {}));

  assert.equal(res.state.statusCode, 500);
  assert.deepEqual(res.state.payload, { Message: 'An error has occurred.' });
});

test('falls back to req.url when originalUrl is absent, and tolerates a missing req', () => {
  const withUrl = fakeRes();
  const lines = captureStderr(() =>
    errorHandler(new Error('x'), { method: 'GET', url: '/fallback' }, withUrl, () => {})
  );
  assert.match(lines[0], /"path":"\/fallback"/);

  const noReq = fakeRes();
  assert.doesNotThrow(() => captureStderr(() => errorHandler(new Error('x'), null, noReq, () => {})));
  assert.equal(noReq.state.statusCode, 500);
});
