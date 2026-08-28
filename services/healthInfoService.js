'use strict';

/**
 * Works out whether the service and every database it uses are healthy.
 *
 * WHY IT EXISTS: One database being down should be visible, not hidden behind an overall
 *                'everything is fine'.
 *
 * ROLE IN THE FLOW: Called by the health controller. Checks each configured database separately.
 */

const oracleRepository = require('../repositories/oracleRepository.js');
const tenantRegistry = require('../config/tenantRegistry.js');
const appStatus = require('../utils/appStartTime.js');

/**
 * Builds the payload for `GET /DBAPI/Health-Info`.
 *
 * The `application.startedAt` and `application.uptime` fields describe THIS PROCESS.
 * On a conventional server that is the application's uptime; on a serverless host it
 * is the age of the instance serving the request, which is frequently only seconds
 * and differs between requests. See utils/appStartTime.js.
 */

/**
 * Probes one routed database.
 *
 * Never throws: a health endpoint that 500s because a database is down reports
 * nothing useful about WHICH database is down, which is the only question worth
 * asking of it.
 */
async function probeConnection(connection) {
  try {
    // Proves the pool can still hand out a usable session, rather than only that an
    // object exists: a pool whose backend has gone away still looks fine.
    // verifyConnectableFor() also CREATES the pool if this connection has never been
    // used, so a database no request has touched yet is still checked - and that is
    // the one most likely to be misconfigured.
    await oracleRepository.verifyConnectableFor(connection);
    return {
      name: connection.name,
      envPrefix: connection.poolKey || null,
      status: 'UP',
      connected: true,
      error: null
    };
  } catch (error) {
    return {
      name: connection.name,
      envPrefix: connection.poolKey || null,
      status: 'DOWN',
      connected: false,
      error: error.message
    };
  }
}

/**
 * Probes every distinct database the routing map can reach.
 *
 * Deduplicated by pool identity upstream, so two sources sharing credentials are
 * probed once. Before routing existed this checked the single default pool; with
 * routing, checking only that pool would report the service healthy while a routed
 * database was unreachable - the failure the endpoint exists to catch.
 */
async function probeAllConnections() {
  let connections;
  try {
    // Deduplicated by pool identity, so blocks sharing credentials are probed once.
    const seen = new Map();
    for (const block of tenantRegistry.allBlocks()) {
      const connection = tenantRegistry.connectionFor(block);
      if (!seen.has(connection.poolKey)) seen.set(connection.poolKey, connection);
    }
    connections = [...seen.values()];
  } catch (error) {
    // An unloadable routing map is itself a health problem, and a more serious one
    // than any single database being down: nothing can be routed at all.
    return [{ name: 'routing-map', envPrefix: null, status: 'DOWN', connected: false, error: error.message }];
  }

  return Promise.all(connections.map(probeConnection));
}

async function getHealthInfoService() {
  const appStartInfo = appStatus.getApplicationStartTime();
  const databases = await probeAllConnections();

  // The aggregate is healthy only when EVERY routed database is. A partial outage
  // must not read as UP: some source's traffic is failing.
  const allConnected = databases.length > 0 && databases.every((entry) => entry.connected);
  const firstFailure = databases.find((entry) => !entry.connected);

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

    // PRESERVED SHAPE. Existing monitors read database.status / .connected / .error,
    // so this stays exactly as it was and now summarises all routed databases.
    database: {
      status: allConnected ? 'UP' : 'DOWN',
      connected: allConnected,
      error: firstFailure ? firstFailure.error : null
    },

    // ADDITIVE. Which database is actually down - the thing the aggregate cannot say.
    databases
  };
}

module.exports = {
  getHealthInfoService
};
