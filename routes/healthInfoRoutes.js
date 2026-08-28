'use strict';
const express = require('express');
const controller = require('../controllers/healthInfoController.js');

const router = express.Router();

router.get('/DBAPI/Health-Info', controller.getHealthInfo);
module.exports = router;
