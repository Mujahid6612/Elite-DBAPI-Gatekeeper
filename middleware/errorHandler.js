'use strict';

const envConfig = require('../config/env');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (envConfig.exposeErrors) {
    return res.status(500).json({ Message: err.message, StackTrace: err.stack || '' });
  }
  // Approximate classic ASP.NET Web API's non-debug generic exception response.
  return res.status(500).json({ Message: 'An error has occurred.' });
}

module.exports = errorHandler;
