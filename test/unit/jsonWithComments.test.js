'use strict';

/**
 * UNIT TEST — utils/jsonWithComments.js.
 *
 * The case that matters most is the third one. `connectionString` holds BASE64, whose
 * alphabet includes `/`, so ciphertext can legitimately contain `//`. A regex-based
 * comment stripper would truncate it mid-value and the block would fail to decrypt with
 * nothing to point at. Every other test here exists to keep that scanner honest.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripJsonComments, parseJsonWithComments } = require('../../utils/jsonWithComments');
const { encryptString } = require('../../utils/encryption');

test('line comments are removed', () => {
  const parsed = parseJsonWithComments(`{
    // which database this block serves
    "target": "DBAPI"   // trailing comment
  }`);
  assert.deepEqual(parsed, { target: 'DBAPI' });
});

test('block comments are removed, including multi-line ones', () => {
  const parsed = parseJsonWithComments(`{
    /* several lines
       of explanation */
    "companyNum": "101" /* inline */
  }`);
  assert.deepEqual(parsed, { companyNum: '101' });
});

test('a // INSIDE a string is data, not a comment', () => {
  // The whole reason this is a scanner and not a regex.
  const parsed = parseJsonWithComments('{"connectionString":"ab//cd","logPath":"~/Log"}');
  assert.equal(parsed.connectionString, 'ab//cd');
  assert.equal(parsed.logPath, '~/Log');
});

test('real base64 ciphertext containing a slash pair survives intact', () => {
  // Generated rather than hand-written, so this keeps testing the real alphabet.
  let cipherText = '';
  for (let i = 0; i < 400 && !cipherText.includes('//'); i += 1) {
    const candidate = encryptString(`Data Source=DB${i};user id=U${i};password=P${i};`, 'k');
    if (candidate.includes('//')) cipherText = candidate;
  }
  assert.ok(cipherText, 'expected to generate ciphertext containing //');

  const parsed = parseJsonWithComments(`{
    // credentials for this database
    "connectionString": ${JSON.stringify(cipherText)}
  }`);
  assert.equal(parsed.connectionString, cipherText, 'ciphertext must not be truncated');
});

test('an escaped quote does not end a string early', () => {
  const parsed = parseJsonWithComments('{"note":"a \\" then // not a comment"}');
  assert.equal(parsed.note, 'a " then // not a comment');
});

test('a /* inside a string is data too', () => {
  const parsed = parseJsonWithComments('{"note":"/* not a comment */"}');
  assert.equal(parsed.note, '/* not a comment */');
});

test('line numbers are preserved, so a parse error still points near the fault', () => {
  const text = `{
    // one
    /* two
       three */
    "a": 1,
  }`;
  const stripped = stripJsonComments(text);
  assert.equal(stripped.split('\n').length, text.split('\n').length);
});

test('plain JSON with no comments is unchanged', () => {
  const text = '{"a":1,"b":[1,2],"c":"x"}';
  assert.equal(stripJsonComments(text), text);
});

test('the shipped config parses, comments and all', () => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', '..', 'config', 'tenants.jsonc');
  const parsed = parseJsonWithComments(fs.readFileSync(file, 'utf8'));

  assert.ok(parsed.default, 'default block present');
  assert.ok(Array.isArray(parsed.databases) && parsed.databases.length > 0);
});
