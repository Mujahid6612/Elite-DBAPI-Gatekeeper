'use strict';

const oracleRepository = require('../repositories/oracleRepository.js');
const appStatus = require('../utils/appStartTime.js');

/**
 * Builds the payload for `GET /DBAPI/Health-Info`.
 *
 * The `application.startedAt` and `application.uptime` fields describe THIS PROCESS.
 * On a conventional server that is the application's uptime; on a serverless host it
 * is the age of the instance serving the request, which is frequently only seconds
 * and differs between requests. See utils/appStartTime.js.
 */
async function getHealthInfoService() {
  const appStartInfo = appStatus.getApplicationStartTime();

  let dbStatus = false;
  let dbError = null;

  try {
    // ensurePool(), NOT connectDB(). connectDB() unconditionally builds a new pool
    // and overwrites the module's reference to the previous one, so calling it here
    // leaked a whole Oracle pool - up to poolMax sessions - on EVERY health check.
    // A monitoring system polling this endpoint would have drained the database's
    // session limit. ensurePool() returns the existing pool when one is live.
    await oracleRepository.ensurePool();

    // Proves the pool can still hand out a usable connection, rather than only that
    // an object exists: a pool whose backend has gone away still looks fine.
    dbStatus = await oracleRepository.verifyConnectable();
  } catch (error) {
    dbStatus = false;
    dbError = error.message;
  }

  const uptime = appStatus.getUptimeDuration(appStartInfo.startedAt);

  return {
    serverTime: new Date().toISOString(),

    application: {
      // The process is by definition running if it is answering this request; the
      // database is reported separately below so a caller can tell the two apart.
      status: 'UP',
      startedAt: appStartInfo.startedAt,
      pid: appStartInfo.pid,
      uptime: uptime ? { ...uptime, formatted: appStatus.formatUptime(uptime) } : null
    },

    database: {
      status: dbStatus ? 'UP' : 'DOWN',
      connected: dbStatus,
      error: dbError
    }
  };
}

module.exports = {
  getHealthInfoService
};
