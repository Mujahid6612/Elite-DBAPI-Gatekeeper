'use strict';

const { fixNullBoolean, fixNullInt, fixNullString } = require('../utils/nullHelpers');
const { decryptString } = require('../utils/encryption');
const { parseConfigXml, childText } = require('./xmlSettingsParser');
const { defaultConfigPath, readConfigDocument } = require('./configSource');
const ipAccessPolicy = require('./ipAccessPolicy');

/**
 * Legacy connection-string encryption parameters. These are fixed by the existing
 * ciphertext in config.xml and cannot be changed without re-encrypting it.
 */
const CONNECTION_STRING_CIPHER = Object.freeze({
  passPhrase: 'SoundViewTechEncryption',
  salt: 'svtlhr',
  hashAlgorithm: 'MD5',
  iterations: 2,
  initVector: '0123456789012345',
  keySize: 256
});

/**
 * Selects the first `<appSettings>` block whose comma-separated `sourceWebsite` list
 * contains `source`, or the literal `*`.
 *
 * FIRST MATCH WINS, including `*`. With the supplied config.xml the wildcard block is
 * listed first, so it shadows the later explicit `SELF` block - `new ConfigReader('SELF')`
 * resolves to company 101, not 999. That is preserved deliberately; reordering the file
 * or preferring exact matches would be a functional change.
 */
function selectTenantBlock(blocks, source) {
  for (const block of blocks) {
    const websites = fixNullString(childText(block, 'sourceWebsite')).split(',');
    for (const website of websites) {
      const candidate = fixNullString(website);
      if (candidate.toUpperCase() === source || candidate === '*') return block;
    }
  }
  return null;
}

/**
 * Per-tenant view over `config.xml`: typed accessors plus the IP gate.
 *
 * Composition only - XML parsing lives in ./xmlSettingsParser, file access in
 * ./configSource, and network policy in ./ipAccessPolicy.
 */
class ConfigReader {
  /**
   * @param {string} sourceWebsite
   * @param {{configPath?: string}} [options]
   */
  constructor(sourceWebsite, options = {}) {
    this.configPath = options.configPath || defaultConfigPath();

    // Deliberately re-read and re-parse on every construction, matching source.
    const blocks = parseConfigXml(readConfigDocument(this.configPath));
    const source = fixNullString(sourceWebsite).toUpperCase();

    this._settings = selectTenantBlock(blocks, source);

    if (!this._settings) {
      throw new Error(`Access Denied. Source website (${sourceWebsite}) is not authorized to query the Web API`);
    }
  }

  _text(key) {
    return fixNullString(childText(this._settings, key));
  }

  get sourceWebsite() {
    return this._text('sourceWebsite');
  }
  get projectName() {
    return this._text('projectName');
  }
  get companyNum() {
    return this._text('companyNum');
  }
  get whitelistedIPs() {
    return this._text('whitelistedIPs');
  }
  get blacklistedIPs() {
    return this._text('blacklistedIPs');
  }
  get enableLogging() {
    return fixNullBoolean(childText(this._settings, 'enableLogging'));
  }
  get apiUserName() {
    return this._text('apiUserName');
  }
  get apiPassword() {
    return this._text('apiPassword');
  }
  get dbType() {
    return this._text('dbType');
  }
  get driverType() {
    return this._text('driverType');
  }
  get procName() {
    return this._text('procName');
  }
  get logType() {
    return fixNullInt(childText(this._settings, 'logType'));
  }
  get logPath() {
    return this._text('logPath');
  }

  get targetDBConnectionString() {
    const cipher = CONNECTION_STRING_CIPHER;
    return decryptString(
      this._text('targetDBConnectionString'),
      cipher.passPhrase,
      cipher.salt,
      cipher.hashAlgorithm,
      cipher.iterations,
      cipher.initVector,
      cipher.keySize
    );
  }

  isIPBlacklisted(ipAddress, checkStarCondition = false) {
    return ipAccessPolicy.isIPBlacklisted(this.whitelistedIPs, this.blacklistedIPs, ipAddress, checkStarCondition);
  }

  isIPWhitelisted(ipAddress, checkStarCondition = false) {
    return ipAccessPolicy.isIPWhitelisted(this.whitelistedIPs, this.blacklistedIPs, ipAddress, checkStarCondition);
  }
}

module.exports = ConfigReader;
