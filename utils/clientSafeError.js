'use strict';

/**
 * Decides which failure text may be shown to an HTTP caller.
 *
 * WHY THIS EXISTS. `POST /DBAPI/ProcessRequest` returns the caught exception's
 * message as a NORMAL action result - HTTP 200 with the text as the body. That part
 * is contractual and is preserved (see the controller). What was NOT safe is WHICH
 * text got out: any failure after tenant resolution was echoed verbatim, so an Oracle
 * driver error reached the caller complete with `ORA-` codes, the schema and package
 * name of the failing procedure, and often a line number inside it. Both supplied
 * tenants set `whitelistedIPs=*`, so on the public deployment that was available to
 * anonymous callers and made the database's internal structure enumerable by
 * malformed request.
 *
 * DATABASE FAILURES. A failure from the database driver is no longer the opaque generic string. The caller is
 * told the fault is on the database side, what to check, and the error code (`ER_SP_DOES_NOT_EXIST`,
 * `ORA-12154`, `ECONNREFUSED`). The driver's own message, which can name hosts, schemas and procedures, is
 * appended only when EXPOSE_DB_ERROR_DETAIL is true.
 *
 * WHAT STILL PASSES THROUGH. The messages the API means as answers, unchanged:
 *
 *  - anything starting `Access Denied.` - the blacklist, invalid-credentials and
 *    unauthorized-source messages, all three of which a client is expected to read
 *    and act on. The prefix rule keeps that true for any future sibling message;
 *  - the .NET null-reference text for a missing required member, which tells an
 *    integrator their body is incomplete and is pinned by the characterization tests;
 *  - JSON syntax errors, which describe the CALLER'S OWN input and disclose nothing
 *    about this service.
 *
 * Everything else is replaced with the same generic string `middleware/errorHandler.js`
 * already returns for unhandled errors, so the two paths look alike from outside. The
 * real message is not lost - the caller of this helper logs it to the tenant audit log
 * and the application log first.
 */

const { Messages } = require('../constants');
const envConfig = require('../config/env');

/** Matches classic ASP.NET Web API's non-debug generic exception response text. */
const GENERIC_MESSAGE = 'An error has occurred.';

/**
 * Prefix shared by every deliberate access-control answer, including
 * `Messages.BLACKLISTED_MESSAGE` (which the service suffixes with ` [IP:...]`),
 * `Messages.INVALID_CREDENTIALS`, and ConfigReader's unauthorized-source error.
 */
const ACCESS_DENIED_PREFIX = 'Access Denied.';

/** The .NET null-reference text raised for a missing required body member. */
const MISSING_MEMBER_MESSAGE = 'Object reference not set to an instance of an object.';

/**
 * True when `error` is a body-parsing failure. `JSON.parse` raises a real
 * `SyntaxError`; the name check additionally covers a structured-clone or subclassed
 * error crossing a module boundary, where `instanceof` can fail.
 */
function isBodySyntaxError(error) {
  return error instanceof SyntaxError || (error && error.name === 'SyntaxError');
}

/** Start of every database-failure message; clients can match on it. */
const DATABASE_ERROR_PREFIX = 'Database error.';

const DATABASE_ERROR_ADVICE =
  'The request reached the Gatekeeper but the database side could not complete it. ' +
  'Please check the database (connection, credentials, availability) and the DB action (stored procedure) being called.';

/** Longest driver message appended when detail is exposed. */
const MAX_DETAIL_LENGTH = 500;

/** Driver-prefixed messages: Oracle server, PL/SQL, node-oracledb, ODPI-C and TNS errors. */
const ORACLE_MESSAGE = /^(ORA|PLS|NJS|DPI|TNS)-\d+/;

/** Connection-level failures that, on this service, can only be the path to a database. */
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH', 'EPIPE']);

/** mssql driver error codes. */
const MSSQL_CODES = new Set(['ELOGIN', 'EREQUEST', 'ETIMEOUT', 'ESOCKET', 'ECONNCLOSED', 'ENOTOPEN', 'EINSTLOOKUP']);

/**
 * The short, safe error identifier for a database failure, or '' when there is none worth showing:
 * the MySQL `ER_*` name, an `ORA-nnnnn` number, a network code. Codes name a class of fault, not a
 * host, schema or procedure.
 */
function databaseErrorCode(error) {
  const fromMessage = ORACLE_MESSAGE.exec(String((error && error.message) || ''));
  if (fromMessage) return fromMessage[0];
  if (Number.isInteger(error && error.errorNum)) return `ORA-${String(error.errorNum).padStart(5, '0')}`;

  const code = error && typeof error.code === 'string' ? error.code : '';
  return /^[A-Za-z0-9_-]{1,40}$/.test(code) ? code : '';
}

/**
 * True when `error` came from talking to a database: a MySQL (`ER_*`, `sqlState`), Oracle (`ORA-`,
 * `errorNum`) or SQL Server driver error, or a failure to reach the server. Decided from the error's
 * shape, not from free text, except for the Oracle prefixes and the plain network words a driver puts
 * in `message` when it throws a bare Error.
 */
function isDatabaseError(error) {
  if (!error || typeof error !== 'object') return false;

  const message = String(error.message || '');
  const code = typeof error.code === 'string' ? error.code : '';

  if (ORACLE_MESSAGE.test(message) || Number.isInteger(error.errorNum)) return true;
  if (code.startsWith('ER_') || typeof error.sqlState === 'string' || typeof error.sqlMessage === 'string') {
    return true;
  }
  if (NETWORK_CODES.has(code) || MSSQL_CODES.has(code) || code.startsWith('PROTOCOL_')) return true;
  if (/\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EHOSTUNREACH)\b/.test(message)) return true;

  // Raised by this service's own MySQL driver for a stored procedure that returned nothing, and for
  // a connect string it cannot use. Both are database-side problems.
  return /^(No response received from stored procedure|MySQL connect string for)/.test(message);
}

/**
 * The text a caller receives for a database failure: that the problem is on the database side, what to
 * check, the error code when there is one, and - only when EXPOSE_DB_ERROR_DETAIL is on - the
 * database's own message on a single line.
 */
function databaseErrorMessage(error, exposeDetail) {
  const code = databaseErrorCode(error);
  let text = `${DATABASE_ERROR_PREFIX} ${DATABASE_ERROR_ADVICE}`;
  if (code) text += ` [DB error code: ${code}]`;

  if (exposeDetail) {
    const detail = String((error && (error.sqlMessage || error.message)) || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_DETAIL_LENGTH);
    if (detail) text += ` Details: ${detail}`;
  }
  return text;
}

/**
 * @param {unknown} error The caught failure.
 * @param {{exposeDetail?: boolean}} [options] Overrides EXPOSE_DB_ERROR_DETAIL (used by tests).
 * @returns {string} Text that is safe to put in an HTTP response body.
 */
function clientSafeMessage(error, { exposeDetail = envConfig.exposeDbErrorDetail } = {}) {
  const message = error && error.message ? String(error.message) : '';

  if (message.startsWith(ACCESS_DENIED_PREFIX)) return message;
  if (message === MISSING_MEMBER_MESSAGE) return message;
  if (isBodySyntaxError(error)) return message;
  if (isDatabaseError(error)) return databaseErrorMessage(error, exposeDetail);

  return GENERIC_MESSAGE;
}

/** True when `clientSafeMessage` would not show this error's own text, so the full text must be logged. */
function isRedacted(error, options) {
  const message = error && error.message ? String(error.message) : '';
  return clientSafeMessage(error, options) !== message;
}

module.exports = {
  clientSafeMessage,
  isRedacted,
  isDatabaseError,
  GENERIC_MESSAGE,
  DATABASE_ERROR_PREFIX,
  ACCESS_DENIED_PREFIX,
  MISSING_MEMBER_MESSAGE,
  // Re-exported so a caller can assert the allowlist covers the constants it relies on.
  Messages
};
