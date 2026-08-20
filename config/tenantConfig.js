'use strict';

const fs = require('fs');
const path = require('path');
const { fixNullBoolean, fixNullInt, fixNullString } = require('../utils/nullHelpers');
const { decryptString } = require('../utils/encryption');
const envConfig = require('./env');

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * `config.xml` is deliberately a tiny, hand-rolled settings document. Parsing
 * only its repeated `<appSettings>` blocks keeps this dependency-free and
 * avoids changing its semantics from the source .NET `ConfigReader`.
 */
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
      settings[childMatch[1]] = decodeXmlText(childMatch[2]);
    }
    blocks.push(settings);
  }
  return blocks;
}

function childText(settings, key) {
  if (!Object.prototype.hasOwnProperty.call(settings, key)) {
    // Matches the .NET NullReferenceException thrown by SelectSingleNode(key).InnerText.
    throw new TypeError(`Object reference not set to an instance of an object. Missing config node: ${key}`);
  }
  const value = settings[key];
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && '#text' in value) return value['#text'];
  return value;
}

class ConfigReader {
  /**
   * @param {string} sourceWebsite
   * @param {{configPath?: string}} [options]
   */
  constructor(sourceWebsite, options = {}) {
    this.configPath = options.configPath || path.join(envConfig.projectRoot, 'config.xml');

    // Deliberately re-read and re-parse on every construction, matching source.
    const xml = fs.readFileSync(this.configPath, 'utf8').replace(/^\uFEFF/, '');
    const blocks = parseConfigXml(xml);
    const source = fixNullString(sourceWebsite).toUpperCase();
    this._settings = null;

    for (const block of blocks) {
      const websites = fixNullString(childText(block, 'sourceWebsite')).split(',');
      for (const website of websites) {
        const candidate = fixNullString(website);
        if (candidate.toUpperCase() === source || candidate === '*') {
          this._settings = block;
          break;
        }
      }
      if (this._settings) break; // First match wins, including '*'.
    }

    if (!this._settings) {
      throw new Error(`Access Denied. Source website (${sourceWebsite}) is not authorized to query the Web API`);
    }
  }

  _text(key) { return fixNullString(childText(this._settings, key)); }

  get sourceWebsite() { return this._text('sourceWebsite'); }
  get projectName() { return this._text('projectName'); }
  get companyNum() { return this._text('companyNum'); }
  get whitelistedIPs() { return this._text('whitelistedIPs'); }
  get blacklistedIPs() { return this._text('blacklistedIPs'); }
  get enableLogging() { return fixNullBoolean(childText(this._settings, 'enableLogging')); }
  get apiUserName() { return this._text('apiUserName'); }
  get apiPassword() { return this._text('apiPassword'); }
  get dbType() { return this._text('dbType'); }
  get driverType() { return this._text('driverType'); }
  get procName() { return this._text('procName'); }
  get logType() { return fixNullInt(childText(this._settings, 'logType')); }
  get logPath() { return this._text('logPath'); }

  get targetDBConnectionString() {
    return decryptString(
      this._text('targetDBConnectionString'),
      'SoundViewTechEncryption', 'svtlhr', 'MD5', 2, '0123456789012345', 256
    );
  }

  isIPBlacklisted(ipAddress, checkStarCondition = false) {
    const blacklistedIPs = this.blacklistedIPs;
    if (blacklistedIPs === '*') {
      return checkStarCondition && !this.isIPWhitelisted(ipAddress);
    }
    return blacklistedIPs.split(',').some((ip) => fixNullString(ip) === fixNullString(ipAddress));
  }

  isIPWhitelisted(ipAddress, checkStarCondition = false) {
    const whitelistedIPs = this.whitelistedIPs;
    if (whitelistedIPs === '*') {
      return checkStarCondition && !this.isIPBlacklisted(ipAddress);
    }
    return whitelistedIPs.split(',').some((ip) => fixNullString(ip) === fixNullString(ipAddress));
  }
}

module.exports = ConfigReader;
