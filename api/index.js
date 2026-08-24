'use strict';

/**
 * Vercel serverless entrypoint.
 *
 * Vercel never runs server.js: there is no long-lived process to call app.listen()
 * on. It invokes this module's export as a `(req, res)` handler instead, and an
 * Express app is exactly that, so the app is re-exported unchanged.
 *
 * Two consequences of that difference are handled elsewhere, not here:
 *  - The Oracle pool cannot be created at startup, because there is no startup.
 *    repositories/oracleRepository.js creates it lazily on first use instead.
 *  - Environment validation cannot abort the process. See validateEnvOnce() below.
 *
 * Keep this file free of route logic. app.js remains the single definition of the
 * HTTP surface, so the local server and the deployed function serve the same thing.
 */

const app = require('../app');
const { validateEnv } = require('../config/validateEnv');
const appLogger = require('../utils/appLogger');

// server.js fails fast on bad configuration by exiting. A function instance cannot
// exit without turning every request into a platform-level 500 with no diagnostic,
// so the problems are logged once per cold start and the request is allowed to
// proceed to its own, more specific error.
let validated = false;
function validateEnvOnce() {
  if (validated) return;
  validated = true;
  try {
    validateEnv();
  } catch (error) {
    appLogger.error(error.message);
  }
}

module.exports = (req, res) => {
  validateEnvOnce();
  return app(req, res);
};
