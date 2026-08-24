'use strict';

/**
 * UNIT TEST — utils/logRedaction.js
 *
 * Guards the one deliberate deviation from audit-log parity: `APIPassword` values
 * are masked before the request body reaches the log. This matters because
 * enableLogging is now ON for the live tenant, so the body of EVERY request is
 * written to disk and echoed to the platform log stream.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets, REDACTED } = require('../../utils/logRedaction');

test('masks APIPassword but keeps APILogin, which identifies the caller', () => {
  const body = '{"APILogin":"user@webapis.com","APIPassword":"12345"}';
  const output = redactSecrets(body);

  assert.ok(!output.includes('12345'), 'the password must not survive');
  assert.ok(output.includes(REDACTED));
  assert.ok(output.includes('user@webapis.com'), 'APILogin is an identifier, not a secret');
});

test('a password containing an escaped quote cannot terminate the match early', () => {
  // A naive [^"]* pattern stops at the backslash-escaped quote and leaks the tail.
  const body = String.raw`{"APIPassword":"pa\"ss word","ViewName":"AUTH"}`;
  const output = redactSecrets(body);

  assert.ok(!output.includes('ss word'), `leaked tail of the secret: ${output}`);
  assert.ok(output.includes('"ViewName":"AUTH"'), 'must not swallow the following members');
});

test('matching is case-insensitive and tolerates whitespace around the colon', () => {
  assert.ok(redactSecrets('{"apipassword":"x"}').includes(REDACTED));
  assert.ok(redactSecrets('{ "APIPassword"  :   "x" }').includes(REDACTED));
});

test('text without a secret is returned byte-for-byte unchanged', () => {
  // Everything except the secret VALUE is contractual audit output (guardrail G6).
  const body = '{"ActionCode":"LOGIN","ViewName":"AUTH","Notes":"Test Notes ..."}';
  assert.equal(redactSecrets(body), body);
});

test('null and undefined pass through rather than becoming the string "null"', () => {
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), undefined);
});

test('every occurrence is masked, not just the first', () => {
  const body = '{"a":{"APIPassword":"one"},"b":{"APIPassword":"two"}}';
  const output = redactSecrets(body);

  assert.ok(!output.includes('one') && !output.includes('two'), output);
  assert.equal(output.split(REDACTED).length - 1, 2);
});
