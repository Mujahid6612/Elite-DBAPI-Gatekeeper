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

/**
 * @param {unknown} error The caught failure.
 * @returns {string} Text that is safe to put in an HTTP response body.
 */
function clientSafeMessage(error) {
  const message = error && error.message ? String(error.message) : '';

  if (message.startsWith(ACCESS_DENIED_PREFIX)) return message;
  if (message === MISSING_MEMBER_MESSAGE) return message;
  if (isBodySyntaxError(error)) return message;

  return GENERIC_MESSAGE;
}

/** True when `clientSafeMessage` would replace this error's text. */
function isRedacted(error) {
  return clientSafeMessage(error) === GENERIC_MESSAGE && (!error || error.message !== GENERIC_MESSAGE);
}

module.exports = {
  clientSafeMessage,
  isRedacted,
  GENERIC_MESSAGE,
  ACCESS_DENIED_PREFIX,
  MISSING_MEMBER_MESSAGE,
  // Re-exported so a caller can assert the allowlist covers the constants it relies on.
  Messages
};
