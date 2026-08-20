'use strict';

/**
 * UNIT TEST — utils/xmlText.js (Phase 4, CQ-14).
 *
 * Guards the replacement ORDER, which is the whole reason these two functions were
 * consolidated: escapeXml must handle & first, unescapeXml must handle &amp; last.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeXml, unescapeXml } = require('../../utils/xmlText');

test('escapeXml handles all five entities', () => {
  assert.equal(escapeXml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
});

test('unescapeXml handles all five entities', () => {
  assert.equal(unescapeXml('&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;'), `<a href="x">&'</a>`);
});

test('escapeXml replaces & first, so entities are not double-escaped', () => {
  // If & were replaced last, '<' would become '&amp;lt;'.
  assert.equal(escapeXml('<'), '&lt;');
  assert.equal(escapeXml('&'), '&amp;');
  assert.equal(escapeXml('&lt;'), '&amp;lt;', 'literal text that looks like an entity must be escaped');
});

test('unescapeXml replaces &amp; last, so decoding does not cascade', () => {
  // If &amp; were decoded first, '&amp;lt;' would collapse all the way to '<'.
  assert.equal(unescapeXml('&amp;lt;'), '&lt;');
  assert.equal(unescapeXml('&amp;'), '&');
});

test('the pair round-trips for text containing every special character', () => {
  for (const original of [`<a href="x">&'</a>`, '&', '&amp;', '&lt;', 'plain text', '', 'a&b<c>d"e\'f']) {
    assert.equal(unescapeXml(escapeXml(original)), original, `round-trip failed for: ${original}`);
  }
});

test('null and undefined behave as they did in the two original copies', () => {
  // unescapeXml (was decodeXmlText) coerced falsy input to ''.
  assert.equal(unescapeXml(null), '');
  assert.equal(unescapeXml(undefined), '');
  // escapeXml (was xmlEscape) used a bare String(), so it stringifies them.
  assert.equal(escapeXml(null), 'null');
  assert.equal(escapeXml(undefined), 'undefined');
});
