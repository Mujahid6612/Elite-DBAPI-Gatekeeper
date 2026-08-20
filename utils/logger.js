'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { LogType } = require('../constants');
const envConfig = require('../config/env');

const BORDER = '=====================================================================================';

function getLineBreakCharacter(logType) {
  if (Number(logType) === LogType.Html) return '<br>';
  if (Number(logType) === LogType.EventLog) return '';
  return '\n';
}

/** Close representation of .NET's `DateTime.Now.ToString()` under en-US deployments. */
function dotNetDateTime(date = new Date()) {
  return date.toLocaleString('en-US');
}

function dateFileName(date = new Date()) {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(date.getDate()).padStart(2, '0');
  return `${day}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`;
}

/** Resolves `<logPath>/<company>/<year>/<dd-MMM-yyyy>.<ext>` for a tenant. */
function resolveTenantLogFile(config, date = new Date()) {
  let configured = config.logPath || '~/Log';
  if (configured.startsWith('~/')) configured = configured.slice(2);
  else if (configured.startsWith('~\\')) configured = configured.slice(2);

  const root = path.isAbsolute(configured) ? configured : path.join(envConfig.projectRoot, configured);
  const ext = Number(config.logType) === LogType.Html ? '.html' : '.txt';
  return path.join(root, config.companyNum, String(date.getFullYear()), `${dateFileName(date)}${ext}`);
}

function writeTenant(message, config) {
  if (Number(config.logType) === LogType.EventLog) {
    // Send event log messages to the console when no event log is available.
    if (envConfig.eventLogFallback === 'stdout') console.log(message);
    else console.error(message);
    return;
  }

  const filename = resolveTenantLogFile(config);
  // Create the tenant log folder when it does not exist yet.
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.appendFileSync(filename, `${message}${os.EOL}`, 'utf8');
}

function log(textToWrite, config) {
  const lb = getLineBreakCharacter(config.logType);
  const message = `${BORDER}${lb}Recording message at ${dotNetDateTime()}${lb}${textToWrite}${lb}${BORDER}${lb}`;
  writeTenant(message, config);
}

function requestAndSessionDetails(req, lb) {
  if (!req) return '';

  let message = '';
  const form = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : null;
  if (form && Object.keys(form).length) {
    const keys = Object.keys(form);
    message += `${lb}-------------------------------------------------------------------------------------${lb}`;
    message += ` Total Form Variables :${keys.length}${lb}`;
    message += ` Form Parameter Details are ${lb}`;
    keys.forEach((key, i) => { message += `${i + 1}) ${key} : ${form[key]}${lb}`; });
  }

  const query = req.query || {};
  if (Object.keys(query).length) {
    const keys = Object.keys(query);
    message += `${lb}-------------------------------------------------------------------------------------${lb}`;
    message += ` Total Query String Variables :${keys.length}${lb}`;
    message += ` Query String Parameter Details are ${lb}`;
    keys.forEach((key, i) => { message += `${i + 1}) ${key} : ${query[key]}${lb}`; });
  }

  const session = req.session || null;
  if (session && Object.keys(session).length) {
    const keys = Object.keys(session);
    message += ` Total Session Variables :${keys.length}${lb}`;
    message += `${lb}-------------------------------------------------------------------------------------${lb}`;
    message += `Session Variable Details are ${lb}`;
    keys.forEach((key, i) => { message += `${i + 1}) ${key} : ${session[key]}${lb}`; });
  }

  return message;
}

function getErrorMessage(error, config, req) {
  const lb = getLineBreakCharacter(config.logType);
  let message = `${BORDER}${lb}`;
  message += ` Exception Occured at : ${dotNetDateTime()}${lb}`;
  message += `Type :${error?.name || 'Error'}${lb}`;
  message += `Original Message : ${error?.message || ''}${lb}`;
  message += `Source :${error?.source || ''}${lb}`;
  message += `Stack Trace :${error?.stack || ''}${lb}`;
  message += requestAndSessionDetails(req, lb);
  message += `${BORDER}${lb}`;
  return message;
}

function logException(error, config, req) {
  writeTenant(getErrorMessage(error, config, req), config);
}

module.exports = { getLineBreakCharacter, resolveTenantLogFile, getErrorMessage, log, logException };
