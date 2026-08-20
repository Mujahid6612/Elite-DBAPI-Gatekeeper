'use strict';

/** Mirrors the legacy .NET DriverType enum. */
const DriverType = Object.freeze({ Microsoft: 0, Oracle: 1 });

/** Mirrors the legacy .NET DataBaseType enum. */
const DataBaseType = Object.freeze({ OLEDB: 0, SQLDB: 1, ORACLEDB: 2 });

/** Mirrors the legacy .NET LogType enum. */
const LogType = Object.freeze({ Html: 0, Text: 1, EventLog: 2 });

const Messages = Object.freeze({
  BLACKLISTED_MESSAGE: 'Access Denied. You can not access the required resource because your IP is blacklisted.',
  INVALID_CREDENTIALS: 'Access Denied. You can not access the required resource because you have provided incorrect login/password.'
});

const LibraryConstants = Object.freeze({
  SELF_SOURCE_WEBSITE_NAME: 'SELF'
});

module.exports = { DriverType, DataBaseType, LogType, Messages, LibraryConstants };
