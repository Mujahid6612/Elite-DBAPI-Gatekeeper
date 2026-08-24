'use strict';

const express = require('express');
const cors = require('cors');
const envConfig = require('./config/env');
const corsOptions = require('./middleware/corsPolicy');
const notFoundHandler = require('./middleware/notFoundHandler');
const errorHandler = require('./middleware/errorHandler');
const accessLog = require('./middleware/accessLog');
const routes = require('./routes');

const app = express();

app.set('trust proxy', envConfig.trustProxy);
app.use(cors(corsOptions));

// Keep request bodies as text because this API accepts JSON inside a string.
//
// `type: '*/*'` is REQUIRED and must not be narrowed to application/json. The
// original ASP.NET action signature is `[FromBody]string`, and the historical
// clients post the object text wrapped in single quotes under assorted content
// types (see utils/webApiCompat.js and guardrail G12). Narrowing the matcher would
// leave req.body undefined for those callers.
//
// `limit` is the effective ceiling on a single request and therefore the primary
// denial-of-service control; it is configurable via BODY_LIMIT, defaulting to the
// original 2mb.
app.use(express.text({ type: '*/*', limit: envConfig.bodyLimit }));

// Access logging wraps the routes so it also observes 404s and error responses.
// It only hooks res 'finish', so it adds no work to the request path itself.
app.use(accessLog);

// Register API routes before the standard error responses.
app.use(routes);
app.use(notFoundHandler);
app.use(errorHandler);


module.exports = app;
