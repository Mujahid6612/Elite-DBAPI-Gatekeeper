'use strict';

const { unescapeXml } = require('../utils/xmlText');

/**
 * Parser for `config.xml`'s hand-rolled settings format.
 *
 * `config.xml` is deliberately a tiny settings document. Parsing only its repeated
 * `<appSettings>` blocks keeps this dependency-free and avoids changing its
 * semantics from the source .NET `ConfigReader`.
 *
 * Pure functions only: no file system, no tenant selection, no coercion.
 */

/** @returns {Array<Record<string, string>>} one plain object per <appSettings> block */
function parseConfigXml(xml) {
  const blocks = [];
  const blockRegex = /<appSettings>([\s\S]*?)<\/appSettings>/gi;
  let blockMatch;
  while ((blockMatch = blockRegex.exec(xml)) !== null) {
    const body = blockMatch[1];
    const settings = {};
    const childRegex = /<([A-Za-z0-9_.-]+)>([\s\S]*?)<\/\1>/g;
    let childMatch;
    while ((childMatch = childRegex.exec(body)) !== null) {
      settings[childMatch[1]] = unescapeXml(childMatch[2]);
    }
    blocks.push(settings);
  }
  return blocks;
}

/**
 * Reads one setting, reproducing the .NET NullReferenceException that
 * `SelectSingleNode(key).InnerText` threw for an absent node. The message text is
 * observable: it reaches the caller as an HTTP response body.
 */
function childText(settings, key) {
  if (!Object.prototype.hasOwnProperty.call(settings, key)) {
    throw new TypeError(`Object reference not set to an instance of an object. Missing config node: ${key}`);
  }
  const value = settings[key];
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && '#text' in value) return value['#text'];
  return value;
}

module.exports = { parseConfigXml, childText };
