'use strict';

const fs = require('fs');
const path = require('path');
const envConfig = require('./env');

/** Default location of the tenant settings document. */
function defaultConfigPath() {
  return path.join(envConfig.projectRoot, 'config.xml');
}

/**
 * Reads the settings document from disk, stripping any UTF-8 BOM.
 *
 * Deliberately performs no caching. The source .NET ConfigReader re-read the file on
 * every construction, so a settings edit takes effect without a restart, and callers
 * depend on that. Do not memoize here.
 */
function readConfigDocument(configPath) {
  return fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
}

module.exports = { defaultConfigPath, readConfigDocument };
