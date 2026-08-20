'use strict';

/**
 * XML entity escaping and unescaping.
 *
 * These two functions are exact inverses and must stay in sync, which is why they
 * live together. Note the ORDERING requirement, which is easy to break:
 *
 *  - `escapeXml` must replace `&` FIRST, otherwise it would go on to double-escape
 *    the ampersands it just introduced (`<` -> `&lt;` -> `&amp;lt;`).
 *  - `unescapeXml` must replace `&amp;` LAST, for the mirror-image reason: decoding
 *    it early would let `&amp;lt;` collapse all the way to `<` instead of `&lt;`.
 */

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

module.exports = { escapeXml, unescapeXml };
