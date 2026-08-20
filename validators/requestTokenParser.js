'use strict';

function missingMemberError() {
  return new TypeError('Object reference not set to an instance of an object.');
}

/** Throws the .NET-style null-reference error when a required field is absent. */
function requireToken(obj, key) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) throw missingMemberError();
  return obj[key];
}

/** Mirrors `JToken.ToString()` used for most fields: primitives pass through as text. */
function tokenToObjectString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (['number', 'boolean', 'bigint'].includes(typeof value)) return String(value);
  return JSON.stringify(value);
}

/** Mirrors `JsonReq`'s handling: objects render as indented JSON with CRLF, matching the Windows source. */
function tokenToString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2).replace(/\n/g, '\r\n');
  }
  return String(value);
}

module.exports = { missingMemberError, requireToken, tokenToObjectString, tokenToString };
