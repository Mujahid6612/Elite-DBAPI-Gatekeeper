'use strict';

/**
 * CHARACTERIZATION TEST — parsers/requestTokenParser.js.
 *
 * The thrown message text is part of the HTTP response body on the POST error
 * path (guardrail G4/G9), so it is asserted literally, not by error type alone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  missingMemberError,
  requireToken,
  tokenToObjectString,
  tokenToString
} = require('../../parsers/requestTokenParser');

const DOTNET_NULL_REF = 'Object reference not set to an instance of an object.';

test('missingMemberError produces the exact .NET null-reference text', () => {
  const error = missingMemberError();
  assert.ok(error instanceof TypeError);
  assert.equal(error.message, DOTNET_NULL_REF);
});

test('requireToken throws the .NET message for absent keys, including inherited ones', () => {
  assert.throws(() => requireToken({}, 'ActionCode'), { name: 'TypeError', message: DOTNET_NULL_REF });
  // hasOwnProperty gate: inherited properties do NOT satisfy the check.
  assert.throws(() => requireToken(Object.create({ ActionCode: 'A' }), 'ActionCode'), { message: DOTNET_NULL_REF });
});

test('requireToken returns present values including null, undefined and falsy ones', () => {
  assert.equal(requireToken({ A: 'x' }, 'A'), 'x');
  assert.equal(requireToken({ A: null }, 'A'), null);
  assert.equal(requireToken({ A: undefined }, 'A'), undefined);
  assert.equal(requireToken({ A: '' }, 'A'), '');
  assert.equal(requireToken({ A: 0 }, 'A'), 0);
  assert.equal(requireToken({ A: false }, 'A'), false);
});

test('tokenToObjectString mirrors JToken.ToString() per type', () => {
  assert.equal(tokenToObjectString(null), null);
  assert.equal(tokenToObjectString(undefined), null);
  assert.equal(tokenToObjectString('text'), 'text');
  assert.equal(tokenToObjectString(''), '');
  assert.equal(tokenToObjectString(42), '42');
  assert.equal(tokenToObjectString(3.5), '3.5');
  assert.equal(tokenToObjectString(true), 'true');
  assert.equal(tokenToObjectString(false), 'false');
  assert.equal(tokenToObjectString(10n), '10');
  assert.equal(tokenToObjectString({ a: 1 }), '{"a":1}');
  assert.equal(tokenToObjectString([1, 2]), '[1,2]');
});

test('tokenToString renders objects as 2-space-indented JSON with CRLF line endings', () => {
  assert.equal(tokenToString(null), '');
  assert.equal(tokenToString(undefined), '');
  assert.equal(tokenToString('raw'), 'raw');
  assert.equal(tokenToString(42), '42');
  assert.equal(tokenToString(true), 'true');

  const rendered = tokenToString({ a: 1, b: 'x' });
  assert.equal(rendered, '{\r\n  "a": 1,\r\n  "b": "x"\r\n}');
  // Every LF must be preceded by CR — the Windows source produced CRLF.
  assert.equal(/(?<!\r)\n/.test(rendered), false, 'found a bare LF');

  assert.equal(tokenToString([1, 2]), '[\r\n  1,\r\n  2\r\n]');
});

test('tokenToString on a string passes through untouched — no CRLF conversion', () => {
  // Only the object branch converts line endings; a string JsonReq is verbatim.
  assert.equal(tokenToString('a\nb'), 'a\nb');
});
