'use strict';

const express = require('express');
const controller = require('../controllers/flightViewController');

const router = express.Router();

// These paths match the existing FlightView API contract.
router.get('/DBAPI/FlightView', controller.getFlightView);
router.get('/DBAPI/FlightView/:id', controller.getFlightViewById);
router.post('/DBAPI/FlightView', controller.noContent);
router.put('/DBAPI/FlightView/:id', controller.noContent);
router.delete('/DBAPI/FlightView/:id', controller.noContent);

module.exports = router;
