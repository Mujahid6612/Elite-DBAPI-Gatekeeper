'use strict';

/**
 * Represents one configuration block from config/tenants.jsonc.
 *
 * WHY IT EXISTS: The rest of the app expects settings in specific shapes (company number as text,
 *                log type as a number). This turns raw JSON into those shapes.
 *
 * ROLE IN THE FLOW: This is the object every other part of the app receives when it asks 'what are
 *                   the settings for this request?'
 */

/**
 * One configuration block from `config/tenants.jsonc`, presented with the exact
 * interface the rest of the service already consumes.
 *
 * REPLACES `config/configReader.js`. That class read the same fields out of an
 * `<appSettings>` element in `config.xml`; this reads them from a JSON object. The
 * getters, their names, their return TYPES and the IP-gate methods are deliberately
 * identical, so `tenantAuditLog`, `diagnosticSummaryView`, `accessLog` and the
 * services did not have to change when the format did.
 *
 * TYPE COERCION IS NOT COSMETIC. XML gave every value as a string, and downstream code
 * was written against that: `companyNum` is bound to a CHAR(3) parameter, `logType` is
 * used as a numeric lookup key, `enableLogging` gates the audit blocks. JSON can carry
 * real numbers and booleans, so a hand-edited `"companyNum": 101` would otherwise reach
 * the database as a number where a string was expected. Every getter normalises to the
 * type the old XML path produced.
 */

const { fixNullBoolean, fixNullInt, fixNullString } = require('../utils/nullHelpers');
const { decryptString } = require('../utils/encryption');
const ipAccessPolicy = require('./ipAccessPolicy');

class Tenant {
  /**
   * @param {object} block a validated block from config/tenants.jsonc
   */
  constructor(block) {
    this._block = block || {};
  }

  /** Raw value, or '' when absent - matching the old `childText` + `fixNullString`. */
  _text(key) {
    const value = this._block[key];
    return fixNullString(value === undefined || value === null ? '' : String(value));
  }

  /** The sources this block serves, for diagnostics and startup logging. */
  get sources() {
    return Array.isArray(this._block.sources) ? this._block.sources : [];
  }

  get target() {
    return this._text('target');
  }

  /**
   * Kept for interface compatibility with the diagnostic summary, which printed the
   * matched `<sourceWebsite>`. There is no Host-based matching any more, so this
   * reports what actually selected the block: its sources, or 'default'.
   */
  get sourceWebsite() {
    const sources = this.sources;
    return sources.length > 0 ? sources.join(',') : this.projectName || 'default';
  }

  /**
   * IDENTIFIES THIS BLOCK. Carried over from the .NET `<projectName>`, where it was a
   * display-only label; it is now the block's only identifier and appears in every
   * validation message, startup log line and health-check entry. There is deliberately
   * no second `name` field - one identifier cannot drift out of step with another.
   */
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
  get logPath() {
    return this._text('logPath');
  }

  /** `1`/`0`, `true`/`false` and `"1"`/`"0"` all work, as they did from XML text. */
  get enableLogging() {
    return fixNullBoolean(this._text('enableLogging'));
  }

  /** Numeric, because utils/tenantAuditLog.js looks up a profile by `Number(logType)`. */
  get logType() {
    return fixNullInt(this._text('logType'));
  }

  /** Names the environment variables holding this database's credentials, if any. */
  get envPrefix() {
    return this._text('envPrefix');
  }

  /** Per-database Oracle session ceiling, or undefined to use the driver default. */
  get poolMax() {
    const value = this._block.poolMax;
    return value === undefined || value === null || value === '' ? undefined : Number(value);
  }

  /**
   * The decrypted ADO connection string, or '' when this block does not carry one.
   *
   * The passphrase comes from the ENVIRONMENT (`CONFIG_ENCRYPTION_KEY`), never from
   * the repository. That is the whole reason this file can hold ciphertext safely,
   * and it is the one thing that must not be "simplified" back to a constant: the
   * previous scheme kept the passphrase in `configReader.js`, so the ciphertext beside
   * it was decryptable by anyone with a clone.
   *
   * Named `targetDBConnectionString` for interface compatibility with the diagnostic
   * view, which is the only remaining consumer of the name.
   */
  get targetDBConnectionString() {
    const cipherText = this._text('connectionString');
    if (cipherText === '') return '';
    return decryptString(cipherText);
  }

  isIPBlacklisted(ipAddress, checkStarCondition = false) {
    return ipAccessPolicy.isIPBlacklisted(this.whitelistedIPs, this.blacklistedIPs, ipAddress, checkStarCondition);
  }

  isIPWhitelisted(ipAddress, checkStarCondition = false) {
    return ipAccessPolicy.isIPWhitelisted(this.whitelistedIPs, this.blacklistedIPs, ipAddress, checkStarCondition);
  }
}

module.exports = Tenant;
