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
  DATABASE_ERROR_PREFIX,
  ACCESS_DENIED_PREFIX,
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

test('an Oracle driver error becomes a database-side message with the code but not the detail', () => {
  const error = new Error(
    'ORA-06550: line 1, column 7:\nPLS-00201: identifier REQUEST_HANDLER.ACTIONS must be declared'
  );
  const safe = clientSafeMessage(error, { exposeDetail: false });

  assert.ok(safe.startsWith(DATABASE_ERROR_PREFIX));
  assert.match(safe, /database side/i);
  assert.match(safe, /\[DB error code: ORA-06550\]/);
  assert.ok(!/PLS-/.test(safe));
  assert.ok(!/REQUEST_HANDLER/.test(safe), 'the procedure name must not leak');
  assert.equal(isRedacted(error, { exposeDetail: false }), true);
});

test('a MySQL error shows its ER_ code by default and its message only when detail is exposed', () => {
  const error = Object.assign(new Error('PROCEDURE gft_dev.request_handler does not exist'), {
    code: 'ER_SP_DOES_NOT_EXIST',
    errno: 1305,
    sqlState: '42000',
    sqlMessage: 'PROCEDURE gft_dev.request_handler does not exist'
  });

  const hidden = clientSafeMessage(error, { exposeDetail: false });
  assert.match(hidden, /^Database error\./);
  assert.match(hidden, /\[DB error code: ER_SP_DOES_NOT_EXIST\]/);
  assert.ok(!/gft_dev/.test(hidden), 'schema name stays out by default');

  const shown = clientSafeMessage(error, { exposeDetail: true });
  assert.match(shown, /Details: PROCEDURE gft_dev\.request_handler does not exist$/);
});

test('exposed detail is a single line and is truncated', () => {
  const error = Object.assign(new Error(`line one\n\n  line two ${'x'.repeat(2000)}`), { code: 'ER_X' });
  const shown = clientSafeMessage(error, { exposeDetail: true });
  assert.ok(!/\n/.test(shown));
  assert.ok(shown.length < 1000);
});

test('connection failures are reported as database-side, with the network code', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED' });
  const hidden = clientSafeMessage(refused, { exposeDetail: false });
  assert.match(hidden, /^Database error\./);
  assert.match(hidden, /\[DB error code: ECONNREFUSED\]/);
  assert.ok(!/127\.0\.0\.1/.test(hidden));

  // A bare Error, as some drivers throw it: recognised from the message words.
  assert.match(
    clientSafeMessage(new Error('connect ETIMEDOUT 10.20.30.40:1521'), { exposeDetail: false }),
    /^Database error\./
  );
  assert.match(clientSafeMessage(new Error('ORA-12154: TNS:could not resolve'), { exposeDetail: false }), /ORA-12154/);
});

test('a SQL Server error code is reported as database-side', () => {
  const error = Object.assign(new Error('Login failed for user'), { code: 'ELOGIN' });
  assert.match(clientSafeMessage(error, { exposeDetail: false }), /\[DB error code: ELOGIN\]/);
});

test("this service's own empty-response and bad-connect-string errors are database-side", () => {
  for (const message of [
    'No response received from stored procedure',
    'MySQL connect string for "GFT" has no Server/Host/Data Source entry'
  ]) {
    assert.match(clientSafeMessage(new Error(message), { exposeDetail: false }), /^Database error\./, message);
  }
});

test('filesystem errors are still replaced by the generic string, so paths stay internal', () => {
  const error = new Error("ENOENT: no such file or directory, open '/var/task/config.xml'");
  assert.equal(clientSafeMessage(error, { exposeDetail: true }), GENERIC_MESSAGE);
  assert.equal(isRedacted(error), true);
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
  const safe = clientSafeMessage(error, { exposeDetail: false });
  assert.ok(!safe.startsWith(ACCESS_DENIED_PREFIX));
  assert.ok(!/secret/.test(safe));
});
