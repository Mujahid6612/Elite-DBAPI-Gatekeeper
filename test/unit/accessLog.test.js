'use strict';

/**
 * UNIT TEST — middleware/accessLog.js
 *
 * The access entry is the ONLY audit record for routes other than
 * POST /DBAPI/ProcessRequest, and the only source anywhere of the response status
 * code, the request duration and the client IP.
 *
 * The middleware is exercised through fake req/res doubles rather than a live
 * server, so these assertions do not depend on a port, on config.xml, or on the
 * project's own Log/ tree.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const path = require('path');

const MIDDLEWARE = path.join(__dirname, '..', '..', 'middleware', 'accessLog.js');
const REQUEST_LOGGER = path.join(__dirname, '..', '..', 'utils', 'requestAuditLog.js');

/** Loads accessLog with utils/requestAuditLog stubbed to capture what it writes. */
function loadWithStub(stubLogger) {
  for (const id of [MIDDLEWARE, REQUEST_LOGGER]) delete require.cache[require.resolve(id)];
  require.cache[require.resolve(REQUEST_LOGGER)] = {
    id: REQUEST_LOGGER,
    filename: REQUEST_LOGGER,
    loaded: true,
    exports: { tryCreateRequestLogger: () => stubLogger }
  };
  return require(MIDDLEWARE);
}

function fakeReq(overrides = {}) {
  return {
    method: 'GET',
    originalUrl: '/DBAPI/FlightView?ACID=AA100',
    headers: { host: 'test.example' },
    socket: { remoteAddress: '9.9.9.9' },
    app: { get: () => false },
    ...overrides
  };
}

/** res is an EventEmitter because the middleware hooks its 'finish' event. */
function fakeRes(statusCode = 200) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  return res;
}

function captureLogger() {
  const lines = [];
  return { lineBreak: '\n', log: (text) => lines.push(text), logException: () => {}, lines };
}

test('writes one ACCESS entry with method, path, status, duration and client IP', () => {
  const logger = captureLogger();
  const accessLog = loadWithStub(logger);
  const res = fakeRes(404);
  let nextCalled = false;

  accessLog(fakeReq({ method: 'POST' }), res, () => {
    nextCalled = true;
  });
  assert.ok(nextCalled, 'the request must continue immediately, not wait on logging');
  assert.equal(logger.lines.length, 0, 'nothing is written until the response finishes');

  res.emit('finish');

  assert.equal(logger.lines.length, 1);
  const entry = logger.lines[0];
  assert.match(entry, /^ACCESS:\n/);
  assert.match(entry, /method=POST/);
  assert.match(entry, /path=\/DBAPI\/FlightView\?ACID=AA100/);
  assert.match(entry, /status=404/, 'the status is only final at finish');
  assert.match(entry, /clientIP=9\.9\.9\.9/);
  assert.match(entry, /durationMs=\d+(\.\d)?/);
});

test('a credential in a query string is redacted, as it is in a body', () => {
  const logger = captureLogger();
  const accessLog = loadWithStub(logger);
  const res = fakeRes();

  accessLog(fakeReq({ originalUrl: '/x?a=1&"APIPassword":"hunter2"' }), res, () => {});
  res.emit('finish');

  assert.ok(!logger.lines[0].includes('hunter2'), logger.lines[0]);
});

test('an unresolvable tenant is skipped rather than throwing', () => {
  // tryCreateRequestLogger returns null for a host matching no config.xml block.
  const accessLog = loadWithStub(null);
  const res = fakeRes();

  accessLog(fakeReq(), res, () => {});
  assert.doesNotThrow(() => res.emit('finish'), 'a missing tenant must not break the response');
});

test('AUDIT_ACCESS_LOG=false disables it without disturbing the request', () => {
  const previous = process.env.AUDIT_ACCESS_LOG;
  process.env.AUDIT_ACCESS_LOG = 'false';
  delete require.cache[require.resolve(path.join(__dirname, '..', '..', 'config', 'env.js'))];

  try {
    const logger = captureLogger();
    const accessLog = loadWithStub(logger);
    const res = fakeRes();
    let nextCalled = false;

    accessLog(fakeReq(), res, () => {
      nextCalled = true;
    });
    res.emit('finish');

    assert.ok(nextCalled, 'next() must still run when logging is off');
    assert.equal(logger.lines.length, 0);
  } finally {
    if (previous === undefined) delete process.env.AUDIT_ACCESS_LOG;
    else process.env.AUDIT_ACCESS_LOG = previous;
    delete require.cache[require.resolve(path.join(__dirname, '..', '..', 'config', 'env.js'))];
  }
});
