'use strict';

const ConfigReader = require('../config/tenantConfig');
const Logger = require('../utils/logger');
const dbRepository = require('../repositories/dbRepository');
const { Messages, LibraryConstants } = require('../constants');
const { fixNullString } = require('../utils/nullHelpers');
const { requireToken, tokenToObjectString, tokenToString } = require('../validators/requestTokenParser');

function dotNetBool(value) {
  return value ? 'True' : 'False';
}

/** Builds the diagnostic GET response text for a resolved tenant + caller. */
function buildDiagnosticSummary(config, clientIP, host) {
  return [
    'Welcome to LCOM Web API.',
    `<br /><br />Source Website: ${config.sourceWebsite}`,
    `<br /><br />Project Name: ${config.projectName}`,
    `<br /><br />Target DB Connection String: ${config.targetDBConnectionString}`,
    `<br /><br />Company Num: ${config.companyNum}`,
    `<br /><br />Whitelisted IPs: ${config.whitelistedIPs}`,
    `<br /><br />Blacklisted IPs: ${config.blacklistedIPs}`,
    `<br /><br />Enable Logging: ${dotNetBool(config.enableLogging)}`,
    `<br /><br />API Username: ${config.apiUserName}`,
    `<br /><br />API Password: ${config.apiPassword}`,
    '<br /><br /> <hr />',
    `<br /><br />User IP Address: ${clientIP}`,
    `<br /><br />Client Website: ${host}`,
    `<br /><br />Is IP Whitelisted: ${dotNetBool(config.isIPWhitelisted(clientIP))}`,
    `<br /><br />Is IP Blacklisted: ${dotNetBool(config.isIPBlacklisted(clientIP))}`
  ].join('');
}

/**
 * Resolves the diagnostic summary for `GET /DBAPI/ProcessRequest/:id`.
 * Preserved as-is: this intentionally exposes the decrypted connection
 * string and API password to any caller that clears the IP gate. See
 * MIGRATION_ANALYSIS.md before removing this behavior.
 */
function getDiagnosticSummary(host, clientIP) {
  const config = new ConfigReader(host);
  if (!config.isIPWhitelisted(clientIP, true)) throw new Error(Messages.BLACKLISTED_MESSAGE);
  return buildDiagnosticSummary(config, clientIP, host);
}

/**
 * Extracts and validates the required fields from the parsed request body,
 * throwing the same .NET-style error the source app would for a missing member.
 */
function extractRequestFields(jObject, config) {
  const fields = {
    actionCode: tokenToObjectString(requireToken(jObject, 'ActionCode')),
    companyNum: config.companyNum,
    viewName: tokenToObjectString(requireToken(jObject, 'ViewName')),
    clientIP: tokenToObjectString(requireToken(jObject, 'ClientIP')),
    jsonReq: tokenToString(requireToken(jObject, 'JsonReq')),
    notes: tokenToObjectString(requireToken(jObject, 'Notes'))
  };

  if (config.apiUserName !== '' && config.apiPassword !== '') {
    const apiUserName = fixNullString(tokenToObjectString(requireToken(jObject, 'APILogin')));
    const apiPassword = fixNullString(tokenToObjectString(requireToken(jObject, 'APIPassword')));
    if (!(config.apiUserName === apiUserName && config.apiPassword === apiPassword)) {
      throw new Error(Messages.INVALID_CREDENTIALS);
    }
  }

  return fields;
}

/**
 * Executes the full `POST /DBAPI/ProcessRequest` flow: IP gate, credential
 * check, stored-procedure dispatch, and marker logging, for an
 * already-resolved tenant `config`.
 * @param {import('../config/tenantConfig')} config
 * @returns {Promise<string>} the response body text
 */
async function handleProcessRequest(config, jsonRequest, observedClientIP) {
  if (config.enableLogging) {
    Logger.log(`REQUEST:${Logger.getLineBreakCharacter(config.logType)}${jsonRequest}`, config);
  }

  if (!config.isIPWhitelisted(observedClientIP, true)) {
    throw new Error(`${Messages.BLACKLISTED_MESSAGE} [IP:${observedClientIP}]`);
  }

  Logger.log(`-1:${Logger.getLineBreakCharacter(config.logType)}`, config);

  const jObject = JSON.parse(jsonRequest);
  Logger.log(`0:${Logger.getLineBreakCharacter(config.logType)}`, config);

  const fields = extractRequestFields(jObject, config);

  if (config.enableLogging) {
    Logger.log(`jsonRequest:${Logger.getLineBreakCharacter(config.logType)}${jsonRequest}`, config);
    Logger.log(`ActionCode:${Logger.getLineBreakCharacter(config.logType)}${fields.actionCode}`, config);
  }

  const dbResult = await dbRepository.processDbRequest({
    connectionString: config.targetDBConnectionString,
    dbType: config.dbType,
    procName: config.procName,
    ...fields
  });

  // C# `Replace('\n', ' ')` removes LF only, leaving any preceding CR intact.
  const response = fixNullString(dbResult.output).replace(/\n/g, ' ');

  Logger.log(`1:${Logger.getLineBreakCharacter(config.logType)}`, config);
  if (config.enableLogging) {
    Logger.log(`RESPONSE:${Logger.getLineBreakCharacter(config.logType)}${response}`, config);
  }
  Logger.log(`2:${Logger.getLineBreakCharacter(config.logType)}`, config);

  return response;
}

/**
 * Handles the POST error path. Intentionally retains the source bug: if
 * `config` failed to construct (e.g. unknown tenant), dereferencing
 * `config.logType` below throws and the request escapes as a 500.
 */
function logProcessRequestFailure(error, config, jsonRequest, req) {
  Logger.log(`3:${Logger.getLineBreakCharacter(config.logType)}`, config);
  const dummyConfig = new ConfigReader(LibraryConstants.SELF_SOURCE_WEBSITE_NAME);
  if (dummyConfig && dummyConfig.enableLogging) {
    Logger.log(`ERRONEOUS-REQUEST:${Logger.getLineBreakCharacter(dummyConfig.logType)}${jsonRequest}`, dummyConfig);
    Logger.logException(error, dummyConfig, req);
  }
}

module.exports = { getDiagnosticSummary, handleProcessRequest, logProcessRequestFailure };
