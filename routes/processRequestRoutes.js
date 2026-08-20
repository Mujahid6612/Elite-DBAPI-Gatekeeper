'use strict';

const express = require('express');
const controller = require('../controllers/processRequestController');
const fromBodyString = require('../middleware/fromBodyString');

const router = express.Router();

// These paths match the existing ProcessRequest API contract.
router.get('/DBAPI/ProcessRequest', controller.getWelcome);
router.get('/DBAPI/ProcessRequest/:id', controller.getDiagnostic);
router.post('/DBAPI/ProcessRequest', fromBodyString, controller.postProcessRequest);

module.exports = router;
