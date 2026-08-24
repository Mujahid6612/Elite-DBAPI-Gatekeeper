'use strict';

const express = require('express');
const flightViewRoutes = require('./flightViewRoutes');
const processRequestRoutes = require('./processRequestRoutes');
const healthInfoRoutes = require('./healthInfoRoutes.js');

const router = express.Router();

// Keep the legacy endpoint groups in one router.
router.use(flightViewRoutes);
router.use(processRequestRoutes);
router.use(healthInfoRoutes);
module.exports = router;
