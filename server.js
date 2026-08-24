'use strict';

const app = require('./app');
const oracleRepository = require('./repositories/oracleRepository');
const sqlServerRepository = require('./repositories/sqlServerRepository');
const envConfig = require('./config/env');
const { validateEnv } = require('./config/validateEnv');
const appLogger = require('./utils/appLogger');
const { saveApplicationStartTime } = require('./utils/appStartTime');

/** Set once shutdown begins, so a second signal does not start a second drain. */
let shuttingDown = false;

/**
 * Releases database pools. Failures are logged rather than thrown: shutdown must
 * continue even if one driver misbehaves.
 */
async function closeDatabasePools() {
  await oracleRepository.closePool();
  await sqlServerRepository.closeAllPools();
}

/**
 * Stops accepting new connections, lets in-flight requests finish, releases database
 * pools, then exits.
 *
 * Without this, SIGTERM from a container runtime or systemd killed the process
 * mid-request: stored-procedure calls were abandoned and database sessions left to
 * time out server-side. A hard timeout still guarantees the process exits, so a hung
 * drain cannot wedge a deployment.
 */
function shutdown(signal, server) {
  if (shuttingDown) return;
  shuttingDown = true;

  appLogger.info(`Received ${signal}, shutting down`);

  const forceExit = setTimeout(() => {
    appLogger.error(`Shutdown exceeded ${envConfig.shutdownTimeoutMs}ms, forcing exit`);
    process.exit(1);
  }, envConfig.shutdownTimeoutMs);
  // Do not let the timer itself keep the event loop alive.
  forceExit.unref();

  // Requests already in flight are allowed to finish, but an idle keep-alive socket
  // holds server.close() open for the full keepAliveTimeout (5s by default). Reap
  // them as they fall idle - a single call at signal time is not enough, because a
  // socket serving a request only becomes idle once its response has been sent.
  server.closeIdleConnections();
  const reapIdleSockets = setInterval(() => server.closeIdleConnections(), 200);
  reapIdleSockets.unref();

  server.close(async () => {
    clearInterval(reapIdleSockets);
    try {
      await closeDatabasePools();
      appLogger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      appLogger.error('Shutdown failed', { message: error && error.message });
      process.exit(1);
    }
  });
}

/**
 * Last-resort handlers. Node terminates on an unhandled rejection by default, which
 * previously produced no diagnostic at all; at minimum the reason is now recorded.
 */
function installProcessSafetyNets() {
  process.on('unhandledRejection', (reason) => {
    appLogger.error('Unhandled promise rejection', {
      message: reason && reason.message ? reason.message : String(reason),
      stack: reason && reason.stack
    });
  });

  process.on('uncaughtException', (error) => {
    appLogger.error('Uncaught exception, exiting', {
      message: error && error.message,
      stack: error && error.stack
    });
    process.exit(1);
  });
}

async function startServer() {
  try {
    // Fail fast on misconfiguration, before any connection is attempted.
    validateEnv();
    installProcessSafetyNets();

    await oracleRepository.connectDB();

    // Check that the new pool can provide a usable database connection.
    await oracleRepository.verifyConnectable();
    appLogger.info('Connected to Oracle database');

    // Bind address is intentionally not configurable: Express defaults to `::`,
    // which accepts both IPv6 and IPv4 clients. Passing an explicit '0.0.0.0' would
    // narrow that to IPv4 only. A HOST variable used to be read here but was never
    // applied, so it was removed rather than silently changing the bind behavior.
    const server = app.listen(envConfig.port, () => {
      appLogger.info(`Server is running on port ${envConfig.port}`);
      saveApplicationStartTime();
    });

    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => shutdown(signal, server));
    }
  } catch (error) {
    if (error && error.name === 'ConfigurationError') {
      // Multi-line and meant for a human reading a failed deploy; no stack needed.
      appLogger.error(error.message);
    } else {
      appLogger.error('Failed to start server', {
        message: error && error.message,
        stack: error && error.stack
      });
    }
    process.exit(1);
  }
}

startServer();
