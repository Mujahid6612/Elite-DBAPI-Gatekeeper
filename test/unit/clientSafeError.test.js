'use strict';

/**
 * UNIT TEST — utils/clientSafeError.js.
 *
 * Guards the allowlist that decides which failure text may leave the process. Two
 * failure modes matter equally here: leaking infrastructure detail to an anonymous
 * caller, and accidentally suppressing one of the messages the API means as an
 * ANSWER, which would break integrators who read them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clientSafeMessage,
  isRedacted,
  GENERIC_MESSAGE,
  MISSING_MEMBER_MESSAGE
} = require('../../utils/clientSafeError');
const { Messages } = require('../../constants');

test('every deliberate access-control message survives verbatim', () => {
  for (const message of [Messages.BLACKLISTED_MESSAGE, Messages.INVALID_CREDENTIALS]) {
    assert.equal(clientSafeMessage(new Error(message)), message);
    assert.equal(isRedacted(new Error(message)), false);
  }
});

test('the blacklist message keeps the IP suffix the service appends', () => {
  const message = `${Messages.BLACKLISTED_MESSAGE} [IP:203.0.113.7]`;
  assert.equal(clientSafeMessage(new Error(message)), message);
});

test("ConfigReader's unauthorized-source message survives, so an integrator sees the cause", () => {
  const message = 'Access Denied. Source website (foo.example) is not authorized to query the Web API';
  assert.equal(clientSafeMessage(new Error(message)), message);
});

test('the .NET missing-member text survives, since it names the caller own body as the fault', () => {
  assert.equal(clientSafeMessage(new TypeError(MISSING_MEMBER_MESSAGE)), MISSING_MEMBER_MESSAGE);
});

test('a JSON syntax error survives, because it describes the caller own input', () => {
  let thrown;
  try {
    JSON.parse('{not json');
  } catch (error) {
    thrown = error;
  }
  assert.equal(clientSafeMessage(thrown), thrown.message);
  assert.match(clientSafeMessage(thrown), /JSON/i);
});

test('an Oracle driver error is replaced, code and object names included', () => {
  const error = new Error(
    'ORA-06550: line 1, column 7:\nPLS-00201: identifier REQUEST_HANDLER.ACTIONS must be declared'
  );
  const safe = clientSafeMessage(error);

  assert.equal(safe, GENERIC_MESSAGE);
  assert.ok(!/ORA-/.test(safe));
  assert.ok(!/PLS-/.test(safe));
  assert.ok(!/REQUEST_HANDLER/.test(safe), 'the procedure name must not leak');
  assert.equal(isRedacted(error), true);
});

test('filesystem and connection errors are replaced, so paths and hosts stay internal', () => {
  const cases = [
    "ENOENT: no such file or directory, open '/var/task/config.xml'",
    'ORA-12154: TNS:could not resolve the connect identifier specified',
    'connect ETIMEDOUT 10.20.30.40:1521'
  ];
  for (const message of cases) {
    assert.equal(clientSafeMessage(new Error(message)), GENERIC_MESSAGE, message);
  }
});

test('a null or message-less error still yields the generic string, never undefined', () => {
  assert.equal(clientSafeMessage(null), GENERIC_MESSAGE);
  assert.equal(clientSafeMessage(undefined), GENERIC_MESSAGE);
  assert.equal(clientSafeMessage(new Error()), GENERIC_MESSAGE);
  assert.equal(clientSafeMessage({}), GENERIC_MESSAGE);
});

test('an error whose own text is already the generic string is not reported as redacted', () => {
  // Otherwise the application log would claim detail was withheld when none was.
  assert.equal(isRedacted(new Error(GENERIC_MESSAGE)), false);
});

test('a message merely CONTAINING the access prefix later on is still replaced', () => {
  // The rule is a prefix, not a substring: a driver error quoting our own text back
  // must not become a way to smuggle detail out.
  const error = new Error('ORA-20001: Access Denied. inner detail /var/task/secret');
  assert.equal(clientSafeMessage(error), GENERIC_MESSAGE);
});
