'use strict';

/** Reproduces the Web.config CORS policy rather than using a broad default. */
const corsOptions = {
  origin: '*',
  methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'],
  allowedHeaders: ['soapaction', 'Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
  maxAge: 86400,
  optionsSuccessStatus: 204
};

module.exports = corsOptions;
