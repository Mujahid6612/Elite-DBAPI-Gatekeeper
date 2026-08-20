'use strict';

/**
 * CHARACTERIZATION TEST — utils/webApiCompat.js under STRING_RESPONSE_MODE=raw.
 *
 * config/env.js reads process.env once at load and freezes the result, so raw mode
 * has to be pinned in its own file. `node --test` gives each file its own process,
 * which keeps this override from leaking into the webapi-mode assertions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.STRING_RESPONSE_MODE = 'raw';

const envConfig = require('../../config/env');
const { sendWebApiString } = require('../../utils/webApiCompat');
const { fakeReq, fakeRes } = require('../helpers/fakeHttp');

test('the raw-mode override took effect', () => {
  assert.equal(envConfig.stringResponseMode, 'raw');
});

test('raw mode returns text/plain and bypasses content negotiation entirely', () => {
  for (const accept of [undefined, 'application/json', 'application/xml', 'text/html']) {
    const res = fakeRes();
    sendWebApiString(fakeReq(accept), res, 'hello');
    assert.deepEqual(res.state, { statusCode: 200, contentType: 'text/plain', body: 'hello' }, `Accept: ${accept}`);
  }
});

test('raw mode sends null/undefined as an empty body and does not escape XML', () => {
  const empty = fakeRes();
  sendWebApiString(fakeReq(undefined), empty, null);
  assert.equal(empty.state.body, '');

  const markup = fakeRes();
  sendWebApiString(fakeReq('application/xml'), markup, '<a>&</a>');
  assert.equal(markup.state.body, '<a>&</a>');
});
