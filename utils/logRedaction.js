'use strict';

/**
 * Masks credentials in text that is about to be written to the audit log.
 *
 * The audit log records the request body verbatim, which for this API means
 * `APIPassword` is written in clear text on EVERY logged request - and with
 * `enableLogging` now on for the live tenant, that is every request rather than
 * none. The log files are plain files on disk (and, on a serverless deployment,
 * are echoed to the platform's log stream), so a reader of the logs would obtain a
 * working credential.
 *
 * DEVIATION FROM SOURCE PARITY, DELIBERATE: the .NET original wrote the body
 * unmodified, and guardrail G6 otherwise treats audit output as contractual. Only
 * the secret VALUE changes; the framing, ordering and every other byte are
 * untouched, so log parsers keep working.
 *
 * Operates on TEXT rather than a parsed object on purpose: the body is logged
 * exactly as received, including whitespace and key order, and round-tripping it
 * through JSON.parse/stringify would silently reformat it.
 */

/** Replacement written in place of a secret value. */
const REDACTED = '***REDACTED***';

/**
 * Keys whose values are masked. `APILogin` is intentionally NOT included: it
 * identifies the caller, which is the point of an audit record, and it is not a
 * secret on its own.
 */
const SECRET_KEYS = Object.freeze(['APIPassword']);

/**
 * Matches `"Key" : "value"` allowing arbitrary whitespace, and consumes escaped
 * characters inside the value so a password containing `\"` cannot terminate the
 * match early and leave part of itself in the log.
 */
function secretPattern(key) {
  return new RegExp(`("${key}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, 'gi');
}

/**
 * @param {string} text Raw request/response text destined for the audit log.
 * @returns {string} The same text with known secret values masked.
 */
function redactSecrets(text) {
  if (text === null || text === undefined) return text;

  let output = String(text);
  for (const key of SECRET_KEYS) {
    output = output.replace(secretPattern(key), `$1"${REDACTED}"`);
  }
  return output;
}

module.exports = { redactSecrets, REDACTED, SECRET_KEYS };
