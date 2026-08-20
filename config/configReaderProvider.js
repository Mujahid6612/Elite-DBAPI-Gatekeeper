'use strict';

const ConfigReader = require('./configReader');

/**
 * The one sanctioned way to obtain a tenant configuration.
 *
 * Callers depend on this function rather than on the concrete class, so tenant
 * resolution can be substituted in tests without a real config.xml on disk, and so
 * "how a tenant is resolved" is decided in one place instead of three.
 *
 * Deliberately does NOT cache: ConfigReader re-reads config.xml on every construction
 * and callers rely on that, so a cache here would be a functional change.
 *
 * @param {string} sourceWebsite
 * @param {{configPath?: string}} [options]
 * @returns {ConfigReader}
 */
function createConfigReader(sourceWebsite, options) {
  return new ConfigReader(sourceWebsite, options);
}

module.exports = { createConfigReader };
