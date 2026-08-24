'use strict';

const {
    getHealthInfoService
} = require('../services/healthInfoService.js');

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
