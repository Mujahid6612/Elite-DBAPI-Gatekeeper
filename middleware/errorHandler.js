'use strict';

/**
 * The last-resort handler for errors nothing else caught.
 *
 * WHY IT EXISTS: Without it an unexpected crash returns nothing useful to the caller and leaves no
 *                record for anyone to investigate.
 *
 * ROLE IN THE FLOW: Runs at the very end of the pipeline, only when a request has already failed.
 */

const envConfig = require('../config/env');
const appLogger = require('../utils/appLogger');

/**
 * Terminal error handler.
 *
 * The response body and status are a contract and must not change: classic
 * ASP.NET Web API returned a generic `{ Message }` payload outside debug mode.
 * Logging is a side channel added on top - before this, unhandled 500s left no
 * trace whatsoever, since the per-tenant audit log only covers the ProcessRequest
 * POST path.
 */
// `next` is unused but required: Express only recognises 4-argument middleware
// as an error handler.
function errorHandler(err, req, res, next) {
  appLogger.error('Unhandled request error', {
    message: err && err.message,
    name: err && err.name,
    stack: err && err.stack,
    method: req && req.method,
    path: req && (req.originalUrl || req.url)
  });

  if (envConfig.exposeErrors) {
    return res.status(500).json({ Message: err.message, StackTrace: err.stack || '' });
  }
  // Approximate classic ASP.NET Web API's non-debug generic exception response.
  return res.status(500).json({ Message: 'An error has occurred.' });
}

module.exports = errorHandler;
