'use strict';

const express = require('express');
const cors = require('cors');
const envConfig = require('./config/env');
const corsOptions = require('./middleware/corsPolicy');
const notFoundHandler = require('./middleware/notFoundHandler');
const errorHandler = require('./middleware/errorHandler');
const routes = require('./routes');

const app = express();

app.set('trust proxy', envConfig.trustProxy);
app.use(cors(corsOptions));

// Keep request bodies as text because this API accepts JSON inside a string.
app.use(express.text({ type: '*/*', limit: '2mb' }));

// Register API routes before the standard error responses.
app.use(routes);
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
