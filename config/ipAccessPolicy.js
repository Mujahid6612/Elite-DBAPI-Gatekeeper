'use strict';

const { fixNullString } = require('../utils/nullHelpers');

/**
 * Whitelist/blacklist matching, extracted verbatim from ConfigReader.
 *
 * The two functions are MUTUALLY RECURSIVE and that is deliberate, not an accident:
 * a `*` list defers to the opposite list, so `isIPWhitelisted('*', ...)` asks whether
 * the address is blacklisted, and vice versa. `checkStarCondition` gates that branch,
 * which is why calling `isIPWhitelisted(ip)` without it returns false for a `*`
 * whitelist even though the caller would be admitted by the gate. The diagnostic
 * summary depends on exactly that asymmetry - see the characterization tests.
 *
 * Matching is exact after trimming: there is no CIDR or wildcard handling. Note that
 * `''.split(',')` is `['']`, so an empty list DOES match an empty/absent address.
 */

function matchesList(csvList, ipAddress) {
  return csvList.split(',').some((entry) => fixNullString(entry) === fixNullString(ipAddress));
}

function isIPBlacklisted(whitelistedIPs, blacklistedIPs, ipAddress, checkStarCondition = false) {
  if (blacklistedIPs === '*') {
    return checkStarCondition && !isIPWhitelisted(whitelistedIPs, blacklistedIPs, ipAddress);
  }
  return matchesList(blacklistedIPs, ipAddress);
}

function isIPWhitelisted(whitelistedIPs, blacklistedIPs, ipAddress, checkStarCondition = false) {
  if (whitelistedIPs === '*') {
    return checkStarCondition && !isIPBlacklisted(whitelistedIPs, blacklistedIPs, ipAddress);
  }
  return matchesList(whitelistedIPs, ipAddress);
}

module.exports = { isIPBlacklisted, isIPWhitelisted };
