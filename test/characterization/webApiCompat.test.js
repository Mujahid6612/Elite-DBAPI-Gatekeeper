'use strict';

/**
 * CHARACTERIZATION TEST — utils/webApiCompat.js in the default 'webapi' mode.
 *
 * This is the wire contract (guardrail G11/G12): status, Content-Type and the exact
 * serialized body for every Accept header the legacy clients send. Raw mode is
 * covered separately in webApiCompatRawMode.test.js (it needs a different env).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const envConfig = require('../../config/env');
const { unwrapFromBodyString, sendWebApiString } = require('../../utils/webApiCompat');
const { fakeReq, fakeRes } = require('../helpers/fakeHttp');

test('these assertions assume STRING_RESPONSE_MODE=webapi', () => {
  assert.equal(envConfig.stringResponseMode, 'webapi');
});

test('unwrapFromBodyString accepts all three historical body shapes', () => {
  const object = '{"ActionCode":"A"}';
  assert.equal(unwrapFromBodyString(`'${object}'`), object, 'legacy single-quoted');
  assert.equal(unwrapFromBodyString(JSON.stringify(object)), object, 'JSON string literal');
  assert.equal(unwrapFromBodyString(object), object, 'direct raw JSON');
});

test('unwrapFromBodyString edge cases', () => {
  assert.equal(unwrapFromBodyString(undefined), '');
  assert.equal(unwrapFromBodyString(null), '');
  assert.equal(unwrapFromBodyString(''), '');
  assert.equal(unwrapFromBodyString('   '), '   ', 'whitespace-only body returns the raw value');
  // A malformed double-quoted literal falls back to the raw text rather than throwing.
  assert.equal(unwrapFromBodyString('"unterminated'), '"unterminated');
  assert.equal(unwrapFromBodyString('"a\\"b"'), 'a"b');
  // Single-quoted unescaping handles \' and \\ only.
  assert.equal(unwrapFromBodyString("'a\\'b'"), "a'b");
  assert.equal(unwrapFromBodyString("'a\\\\b'"), 'a\\b');
});

test('no Accept header serializes as JSON', () => {
  const res = fakeRes();
  sendWebApiString(fakeReq(undefined), res, 'hello');
  assert.deepEqual(res.state, { statusCode: 200, contentType: 'application/json', body: '"hello"' });
});

test('application/json Accept serializes the string as a JSON string literal', () => {
  const res = fakeRes();
  sendWebApiString(fakeReq('application/json'), res, 'hello');
  assert.deepEqual(res.state, { statusCode: 200, contentType: 'application/json', body: '"hello"' });
});

test('application/xml Accept wraps in the DataContract <string> envelope', () => {
  const res = fakeRes();
  sendWebApiString(fakeReq('application/xml'), res, 'hello');
  assert.equal(res.state.statusCode, 200);
  assert.equal(res.state.contentType, 'application/xml');
  assert.equal(res.state.body, '<string xmlns="http://schemas.microsoft.com/2003/10/Serialization/">hello</string>');
});

test('text/xml Accept takes the same XML branch', () => {
  const res = fakeRes();
  sendWebApiString(fakeReq('text/xml'), res, 'hi');
  assert.equal(res.state.contentType, 'application/xml');
  assert.ok(res.state.body.startsWith('<string xmlns='));
});

test('XML branch escapes all five entities', () => {
  const res = fakeRes();
  sendWebApiString(fakeReq('application/xml'), res, `<a href="x">&'</a>`);
  assert.equal(
    res.state.body,
    '<string xmlns="http://schemas.microsoft.com/2003/10/Serialization/">' +
      '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;</string>'
  );
});

test('text/html Accept keeps a JSON body but an HTML content type', () => {
  const res = fakeRes();
  sendWebApiString(fakeReq('text/html'), res, 'hello');
  assert.deepEqual(res.state, { statusCode: 200, contentType: 'text/html', body: '"hello"' });
});

test('multipart/form-data Accept keeps a JSON body but a multipart content type', () => {
  const res = fakeRes();
  sendWebApiString(fakeReq('multipart/form-data'), res, 'hello');
  assert.deepEqual(res.state, { statusCode: 200, contentType: 'multipart/form-data', body: '"hello"' });
});

test('Accept matching is case-insensitive and substring-based', () => {
  const res = fakeRes();
  // Browsers send a long Accept list; the XML branch wins if xml appears at all.
  sendWebApiString(fakeReq('text/html,application/xhtml+xml,application/XML;q=0.9'), res, 'x');
  assert.equal(res.state.contentType, 'application/xml');
});

test('null and undefined values serialize as an empty JSON string', () => {
  for (const value of [null, undefined]) {
    const res = fakeRes();
    sendWebApiString(fakeReq('application/json'), res, value);
    assert.equal(res.state.body, '""');
  }
});

test('non-string values are stringified before serialization', () => {
  const res = fakeRes();
  sendWebApiString(fakeReq('application/json'), res, 42);
  assert.equal(res.state.body, '"42"');
});

test('JSON branch escapes embedded quotes and newlines', () => {
  const res = fakeRes();
  sendWebApiString(fakeReq('application/json'), res, 'a"b\nc');
  assert.equal(res.state.body, '"a\\"b\\nc"');
});

test('an explicit status is honoured', () => {
  const res = fakeRes();
  sendWebApiString(fakeReq('application/json'), res, 'x', 418);
  assert.equal(res.state.statusCode, 418);
});
