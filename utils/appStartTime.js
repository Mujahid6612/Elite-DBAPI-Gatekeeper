'use strict';

const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '..', 'appHealthLogs');
const startTimeFile = path.join(logsDir, 'app-start.json');


function saveApplicationStartTime() {
    fs.mkdirSync(logsDir, { recursive: true });

    const startInfo = {
        startedAt: new Date().toISOString(),
        pid: process.pid
    };

    fs.writeFileSync(
        startTimeFile,
        JSON.stringify(startInfo, null, 2),
        'utf8'
    );

    console.log(`Application started at: ${startInfo.startedAt}`);
}

function getApplicationStartTime() {
    try {
        if (!fs.existsSync(startTimeFile)) {
            return null;
        }

        return JSON.parse(
            fs.readFileSync(startTimeFile, 'utf8')
        );
    } catch (error) {
        console.error('Failed to read application start time:', error);
        return null;
    }
}

function getUptimeDuration(startedAt) {
    const start = new Date(startedAt);
    const now = new Date();

    if (Number.isNaN(start.getTime())) {
        return null;
    }

    let totalSeconds = Math.floor(
        (now.getTime() - start.getTime()) / 1000
    );

    if (totalSeconds < 0) {
        totalSeconds = 0;
    }

    const days = Math.floor(totalSeconds / 86400);
    totalSeconds %= 86400;

    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return {
        days,
        hours,
        minutes,
        seconds
    };
}

function formatUptime(uptime) {
    if (!uptime) {
        return null;
    }

    return `${uptime.days} days, ` +
           `${uptime.hours} hours, ` +
           `${uptime.minutes} minutes, ` +
           `${uptime.seconds} seconds`;
}

module.exports = {
    saveApplicationStartTime,
    getApplicationStartTime,
    getUptimeDuration,
    formatUptime
};
