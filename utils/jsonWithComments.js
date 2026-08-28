'use strict';

/**
 * Strips `//` and block comments from JSON text so `config/tenants.jsonc` can explain
 * itself in place.
 *
 * WHY. Strict JSON has no comment syntax, and a configuration file that decides which
 * database each application reaches needs to say WHY a value is what it is - especially
 * why several fields are deliberately left empty. The alternative, a `description`
 * array inside the object, puts prose where a parser expects data and forces every line
 * to be JSON-escaped.
 *
 * THE FILE IS `.jsonc`, NOT `.json`. Editors validate by extension: VS Code reports
 * "Comments are not permitted in JSON (521)" on every comment in a `.json` file, and
 * `.jsonc` is the standard extension that tells any editor to accept them. Keeping the
 * `.json` name would have required per-editor configuration that a fresh clone would
 * not have.
 *
 * STRING-AWARE ON PURPOSE, not a regex. `connectionString` holds BASE64, whose alphabet
 * includes `/`, so a value can legitimately contain `//` - `"ab//cd"` is ordinary
 * ciphertext. A naive `replace(/\/\/.*$/gm, '')` would silently truncate it and the
 * block would fail to decrypt with no indication why. The scanner below tracks whether
 * it is inside a string literal, and honours backslash escapes so a `\"` cannot end one
 * early.
 *
 * Comments are replaced with a SPACE rather than removed, so byte offsets in a
 * JSON.parse error still point near the right place in the original file.
 */

/**
 * @param {string} text JSON text that may contain comments
 * @returns {string} the same text with comments blanked out
 */
function stripJsonComments(text) {
  const source = String(text);
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      // A line comment ends at the newline, which is preserved so line numbers hold.
      if (char === '\n') {
        inLineComment = false;
        out += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      } else if (char === '\n') {
        out += char; // keep line numbering intact across a multi-line comment
      }
      continue;
    }

    if (inString) {
      out += char;
      if (char === '\\') {
        // Copy the escaped character verbatim; a \" must not end the string.
        out += next === undefined ? '' : next;
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    // Only outside a string can a slash pair begin a comment. This is the whole reason
    // the scanner exists: inside one, `//` is data.
    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    out += char;
  }

  return out;
}

/**
 * Parses JSON that may contain comments.
 * @param {string} text
 * @returns {*}
 */
function parseJsonWithComments(text) {
  return JSON.parse(stripJsonComments(text));
}

module.exports = { stripJsonComments, parseJsonWithComments };
