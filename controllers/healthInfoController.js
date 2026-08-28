'use strict';

/**
 * Handles the /DBAPI/Health-Info web request.
 *
 * WHY IT EXISTS: Monitoring tools need one URL that says whether the service and its databases are working.
 *
 * ROLE IN THE FLOW: A thin layer: asks the health service for the current picture and returns it as JSON.
 */

const { getHealthInfoService } = require('../services/healthInfoService.js');

async function getHealthInfo(req, res, next) {
  try {
    const healthInfo = await getHealthInfoService();

    res.status(200).json(healthInfo);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getHealthInfo
};
