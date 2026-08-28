'use strict';

/**
 * Mirrors the legacy .NET DriverType enum. Retained deliberately even though no code
 * reads it: a block in config/tenants.jsonc may still carry a `driverType`, and this is the
 * only record of what its values mean. Do not delete without also dropping that node.
 */
const DriverType = Object.freeze({ Microsoft: 0, Oracle: 1 });

/** Mirrors the legacy .NET DataBaseType enum. */
const DataBaseType = Object.freeze({ OLEDB: 0, SQLDB: 1, ORACLEDB: 2 });

/** Mirrors the legacy .NET LogType enum. */
const LogType = Object.freeze({ Html: 0, Text: 1, EventLog: 2 });

/**
 * WORDING RULES for anything returned to a caller, both of them load-bearing:
 *
 *  1. START WITH 'Access Denied.' - utils/clientSafeError.js allowlists that prefix,
 *     so the message reaches the client verbatim instead of being replaced by the
 *     generic 'An error has occurred.'
 *  2. AVOID the words 'error', 'failed' and 'exception'. The EliteID web client
 *     rewrites any message containing them into "Job acknowledged. You may close this
 *     browser window now." - so a routing problem would tell a driver their job was
 *     complete. See EliteIDApp/src/services/apiServices.ts (sanitizeErrorMessage).
 */
const Messages = Object.freeze({
  BLACKLISTED_MESSAGE: 'Access Denied. You can not access the required resource because your IP is blacklisted.',
  INVALID_CREDENTIALS:
    'Access Denied. You can not access the required resource because you have provided incorrect login/password.',
  /** Neither Source nor Target could be found in the request's JsonReq.JHeader. */
  MISSING_ROUTE_FIELDS:
    'Access Denied. This request is missing the JsonReq.JHeader values Source and Target, ' +
    'which select the database. Please check the client application configuration.',
  /** Both were present, but no configured route matches them. */
  UNKNOWN_ROUTE:
    'Access Denied. The Source and Target in this request do not match any database configured ' +
    'for this deployment. Please check the client application configuration.'
});

const LibraryConstants = Object.freeze({
  SELF_SOURCE_WEBSITE_NAME: 'SELF'
});

module.exports = { DriverType, DataBaseType, LogType, Messages, LibraryConstants };
