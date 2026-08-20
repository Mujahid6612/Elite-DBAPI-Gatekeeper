'use strict';

/**
 * CHARACTERIZATION TEST — pins the CURRENT behavior of utils/nullHelpers.js.
 *
 * These tables were generated from the existing implementation, not from a spec.
 * They exist so CQ-23 (removing the dead branches and try/catch in fixNullBoolean)
 * can be verified as behavior-preserving. If a refactor changes any cell below,
 * the refactor is wrong — not the test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixNullString, fixNullInt, fixNullBoolean } = require('../../utils/nullHelpers');

const label = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : (JSON.stringify(v) ?? String(v)));

test('fixNullString truth table', () => {
  const table = [
    [null, ''],
    [undefined, ''],
    ['', ''],
    ['   ', ''],
    ['a', 'a'],
    [' a ', 'a'],
    ['Y', 'Y'],
    [0, '0'],
    [1, '1'],
    [-1, '-1'],
    [3.7, '3.7'],
    [true, 'true'],
    [false, 'false'],
    [{}, '[object Object]'],
    [[], '']
  ];
  for (const [input, expected] of table) {
    assert.equal(fixNullString(input), expected, `fixNullString(${label(input)})`);
  }
});

test('fixNullInt truth table', () => {
  const table = [
    [null, 0],
    [undefined, 0],
    ['', 0],
    ['   ', 0],
    ['a', 0],
    ['abc', 0],
    ['12abc', 12],
    ['1', 1],
    ['0', 0],
    ['3.7', 3],
    [3.7, 3],
    [0, 0],
    [1, 1],
    [2, 2],
    [-1, -1],
    [true, 0],
    [false, 0],
    [{}, 0],
    [[], 0]
  ];
  for (const [input, expected] of table) {
    assert.equal(fixNullInt(input), expected, `fixNullInt(${label(input)})`);
  }
});

test('fixNullBoolean truth table — only Y/1/TRUE (any case) and boolean true are truthy', () => {
  const table = [
    ['Y', true],
    ['y', true],
    ['1', true],
    ['TRUE', true],
    ['true', true],
    [1, true],
    [true, true],
    ['N', false],
    ['n', false],
    ['0', false],
    ['FALSE', false],
    ['false', false],
    ['yes', false],
    ['', false],
    ['   ', false],
    ['a', false],
    [0, false],
    [2, false],
    [-1, false],
    [3.7, false],
    [null, false],
    [undefined, false],
    [false, false],
    [{}, false],
    [[], false]
  ];
  for (const [input, expected] of table) {
    assert.equal(fixNullBoolean(input), expected, `fixNullBoolean(${label(input)})`);
  }
});

test('fixNullBoolean returns false rather than throwing when toString() throws', () => {
  // The original wrapped its body in try/catch for exactly this case. Unreachable
  // from config.xml (values are always text), but pinned so CQ-23 cannot silently
  // turn a swallowed error into a propagated one.
  const hostile = {
    toString() {
      throw new Error('nope');
    }
  };
  assert.equal(fixNullBoolean(hostile), false);
});

test('fixNullBoolean: whitespace is NOT trimmed, unlike fixNullString', () => {
  assert.equal(fixNullBoolean(' Y '), false, 'no trim: " Y " is not "Y"');
  assert.equal(fixNullBoolean('Y '), false);
  assert.equal(fixNullBoolean(' 1'), false);
});

test('fixNullBoolean: the null and boolean branches are currently unreachable but results are unchanged', () => {
  // String(null).toUpperCase() === 'NULL', so the `value === null` check at the
  // original line 19 can never be reached; the false result comes from the final
  // fallback instead. Likewise `true`/`false` are caught by the 'TRUE'/'FALSE'
  // string comparisons before the typeof check. Pinned so CQ-23 preserves results.
  assert.equal(fixNullBoolean(null), false);
  assert.equal(fixNullBoolean(true), true);
  assert.equal(fixNullBoolean(false), false);
});
