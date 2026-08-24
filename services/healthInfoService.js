'use strict';

const oracleRepository = require('../repositories/oracleRepository.js');
const appStatus = require('../utils/appStartTime.js');

async function getHealthInfoService() {
    const appStartInfo = appStatus.getApplicationStartTime();

    let dbStatus = false;
    let dbError = null;

    try {
        // Make sure the Oracle pool exists.
        await oracleRepository.connectDB();

        // Verify that the pool can provide a usable connection.
        dbStatus = await oracleRepository.verifyConnectable();

    } catch (error) {
        dbStatus = false;
        dbError = error.message;
    }

    const uptime = appStartInfo
        ? appStatus.getUptimeDuration(appStartInfo.startedAt)
        : null;

    return {
        serverTime: new Date().toISOString(),

        application: {
            status: 'UP',
            startedAt: appStartInfo?.startedAt || null,
            uptime: uptime
                ? {
                    ...uptime,
                    formatted: appStatus.formatUptime(uptime)
                }
                : null
        },

        database: {
            status: dbStatus ? 'UP' : 'DOWN',
            connected: dbStatus,
            error: dbError
        }
    };
}

module.exports = {
    getHealthInfoService
};
