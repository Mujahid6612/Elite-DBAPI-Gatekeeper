'use strict';

function fixNullString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function fixNullInt(value) {
  if (value === null || value === undefined || String(value) === '') return 0;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Truth table: 'Y', '1' and 'TRUE' (any case), plus the boolean `true`, are true.
 * Everything else - including 'N', '0', 'FALSE', null, undefined, other numbers and
 * objects - is false.
 *
 * Note there is deliberately NO trimming, unlike fixNullString: ' Y ' is false.
 *
 * The original spelled this out as seven sequential comparisons, four of which were
 * unreachable (`String(null)` is 'null', not null, so the null check could never
 * fire, and `true`/`false` were already caught by the 'TRUE'/'FALSE' comparisons).
 * The results are unchanged - see the characterization tests, which pin every cell.
 */
function fixNullBoolean(value) {
  if (typeof value === 'boolean') return value;

  let text;
  try {
    text = String(value).toUpperCase();
  } catch {
    // Only reachable for a value whose toString() throws, which the config cannot
    // produce. Preserved because the original swallowed it and returned false.
    return false;
  }

  return text === 'Y' || text === '1' || text === 'TRUE';
}

module.exports = { fixNullString, fixNullInt, fixNullBoolean };
