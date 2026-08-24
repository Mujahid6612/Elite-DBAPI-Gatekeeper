'use strict';

/**
 * UNIT TEST — audit logging on the FlightView route.
 *
 * This route recorded NOTHING before: the tenant content log covers only
 * POST /DBAPI/ProcessRequest, so a FlightView failure left no trace beyond a bare
 * 500, and the upstream URL that produced it was never captured anywhere.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CONTROLLER = path.join(__dirname, '..', '..', 'controllers', 'flightViewController.js');
const SERVICE = path.join(__dirname, '..', '..', 'services', 'flightViewService.js');
const REQUEST_LOGGER = path.join(__dirname, '..', '..', 'utils', 'requestAuditLog.js');

function load({ logger, fetchImpl }) {
  for (const id of [CONTROLLER, SERVICE, REQUEST_LOGGER]) delete require.cache[require.resolve(id)];

  require.cache[require.resolve(REQUEST_LOGGER)] = {
    id: REQUEST_LOGGER,
    filename: REQUEST_LOGGER,
    loaded: true,
    exports: { tryCreateRequestLogger: () => logger }
  };
  require.cache[require.resolve(SERVICE)] = {
    id: SERVICE,
    filename: SERVICE,
    loaded: true,
    exports: {
      buildUpstreamUrl: (query) => `http://upstream.test/fvxml.exe?1=1&ACID=${query.ACID}`,
      fetchFlightView: fetchImpl
    }
  };
  return require(CONTROLLER);
}

function captureLogger() {
  const lines = [];
  const errors = [];
  return {
    lineBreak: '\n',
    log: (text) => lines.push(text),
    logException: (error) => errors.push(error),
    lines,
    errors
  };
}

function fakeRes() {
  const res = {
    statusCode: null,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    type() {
      return res;
    },
    send(payload) {
      res.body = payload;
      return res;
    }
  };
  return res;
}

const req = { query: { ACID: 'AA100' }, headers: { host: 'test.example' } };

test('logs the upstream URL and the response body on success', async () => {
  const logger = captureLogger();
  const controller = load({ logger, fetchImpl: async () => '<flights>ok</flights>' });

  await controller.getFlightView(req, fakeRes(), () => {});

  const [request, response] = logger.lines;
  assert.match(request, /^FLIGHTVIEW-REQUEST:\n/);
  assert.match(request, /ACID=AA100/, 'the upstream URL is what a diagnosis starts from');
  assert.match(response, /^FLIGHTVIEW-RESPONSE:\n/);
  assert.match(response, /<flights>ok<\/flights>/);
});

test('an upstream failure is recorded and still forwarded as a 500', async () => {
  const logger = captureLogger();
  const failure = new Error('Response status code does not indicate success: 503.');
  const controller = load({
    logger,
    fetchImpl: async () => {
      throw failure;
    }
  });

  let forwarded = null;
  await controller.getFlightView(req, fakeRes(), (error) => {
    forwarded = error;
  });

  assert.equal(logger.errors.length, 1, 'the exception must reach the audit log');
  assert.equal(logger.errors[0], failure);
  assert.equal(forwarded, failure, 'the 500 behaviour must be unchanged by logging');
});

test('a request is still served when no tenant matches the host', async () => {
  // tryCreateRequestLogger returns null for an unknown tenant; the route must work.
  const controller = load({ logger: null, fetchImpl: async () => '<flights/>' });
  const res = fakeRes();

  await assert.doesNotReject(() => controller.getFlightView(req, res, () => {}));
  assert.match(String(res.body), /flights/);
});
