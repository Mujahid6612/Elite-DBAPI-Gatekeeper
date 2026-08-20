'use strict';

/**
 * DEV ONLY - runs the real Gatekeeper with the database call stubbed out.
 *
 * Boots the actual Express app, routes, middleware, tenant config, IP gate, audit
 * logging and response formatting. The ONLY thing replaced is
 * `dbRepository.processDbRequest`, which returns a canned payload instead of calling
 * REQUEST_HANDLER.ACTIONS.
 *
 * Use it to verify client wiring - request shape, response parsing, error handling -
 * when you have no Oracle connectivity. It proves nothing about the stored procedure
 * itself, so a real run against Oracle is still required before cutover.
 *
 *   node scripts/dev-stub-db.js
 *   STUB_ACTION_CODE=1 node scripts/dev-stub-db.js    # simulate a business error
 *   STUB_DELAY_MS=2000 node scripts/dev-stub-db.js    # simulate a slow procedure
 *   STUB_FAIL=1 node scripts/dev-stub-db.js           # simulate a DB failure
 */

const app = require('../app');
const dbRepository = require('../repositories/dbRepository');
const envConfig = require('../config/env');
const appLogger = require('../utils/appLogger');

const actionCode = Number(process.env.STUB_ACTION_CODE || 0);
const delayMs = Number(process.env.STUB_DELAY_MS || 0);
const shouldFail = process.env.STUB_FAIL === '1';

/** Mirrors the JHeader/JData envelope the real procedure returns. */
function buildStubResponse(request) {
  return JSON.stringify({
    JHeader: {
      ActionCode: actionCode,
      Message: actionCode === 0 ? 'Success (stubbed)' : 'Stubbed business error',
      ViewName: request.viewName,
      RequestedActionCode: request.actionCode,
      Source: 'dev-stub-db'
    },
    JMetaData: { stub: true, generatedAt: new Date().toISOString() },
    JData: [{ STUB: 'true', ACTION_CODE: request.actionCode, VIEW_NAME: request.viewName }]
  });
}

dbRepository.processDbRequest = async (request) => {
  appLogger.info('STUB processDbRequest', {
    actionCode: request.actionCode,
    viewName: request.viewName,
    companyNum: request.companyNum,
    clientIP: request.clientIP,
    jsonReqBytes: String(request.jsonReq || '').length
  });

  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (shouldFail) throw new Error('ORA-06550: stubbed database failure');

  return { output: buildStubResponse(request), oCode: '0', oMessage: 'stub' };
};

const server = app.listen(envConfig.port, () => {
  appLogger.warn('DEV STUB MODE: the database is NOT being called. Do not use for acceptance testing.');
  appLogger.info(`Stub Gatekeeper listening on port ${envConfig.port}`, {
    stubActionCode: actionCode,
    stubDelayMs: delayMs,
    stubFail: shouldFail
  });
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  });
}
