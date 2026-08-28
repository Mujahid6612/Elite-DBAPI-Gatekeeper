'use strict';

/**
 * Says which websites are allowed to call this API from a browser.
 *
 * WHY IT EXISTS: Copied from the old app's Web.config so existing browser clients keep working
 *                exactly as before.
 *
 * ROLE IN THE FLOW: Applied to every request, before anything else runs.
 */

/** Reproduces the Web.config CORS policy rather than using a broad default. */
const corsOptions = {
  origin: '*',
  methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'],
  allowedHeaders: ['soapaction', 'Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
  maxAge: 86400,
  optionsSuccessStatus: 204
};

module.exports = corsOptions;
