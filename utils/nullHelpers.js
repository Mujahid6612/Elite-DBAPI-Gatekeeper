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

function fixNullBoolean(value) {
  try {
    const text = String(value).toUpperCase();
    if (text === 'Y' || text === '1') return true;
    if (text === 'N' || text === '0') return false;
    if (value === null || value === undefined) return false;
    if (typeof value === 'boolean') return value;
    if (text === 'TRUE') return true;
    if (text === 'FALSE') return false;
    return false;
  } catch {
    return false;
  }
}

module.exports = { fixNullString, fixNullInt, fixNullBoolean };
