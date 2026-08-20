'use strict';

const express = require('express');
const controller = require('../controllers/processRequestController');

const router = express.Router();

// These paths match the existing ProcessRequest API contract.
router.get('/DBAPI/ProcessRequest', controller.getWelcome);
router.get('/DBAPI/ProcessRequest/:id', controller.getDiagnostic);
router.post('/DBAPI/ProcessRequest', controller.postProcessRequest);

module.exports = router;
