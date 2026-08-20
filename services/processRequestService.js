'use strict';

const { createConfigReader } = require('../config/configReaderProvider');
const tenantAuditLog = require('../utils/tenantAuditLog');
const dbRepository = require('../repositories/dbRepository');
const { Messages, LibraryConstants } = require('../constants');
const { fixNullString } = require('../utils/nullHelpers');
const { requireToken, tokenToObjectString, tokenToString } = require('../parsers/requestTokenParser');
const { renderDiagnosticSummary } = require('./diagnosticSummaryView');

/**
 * Resolves the diagnostic summary for `GET /DBAPI/ProcessRequest/:id`.
 *
 * `createConfig` is injectable purely for testing; every production call site uses
 * the default, so behavior is unchanged.
 * Preserved as-is: this intentionally exposes the decrypted connection
 * string and API password to any caller that clears the IP gate. See
 * MIGRATION_ANALYSIS.md before removing this behavior.
 */
function getDiagnosticSummary(host, clientIP, createConfig = createConfigReader) {
  const config = createConfig(host);
  if (!config.isIPWhitelisted(clientIP, true)) throw new Error(Messages.BLACKLISTED_MESSAGE);
  return renderDiagnosticSummary(config, clientIP, host);
}

/**
 * Extracts the required fields from the parsed request body, throwing the same
 * .NET-style error the source app would for a missing member. Extraction only -
 * credential checking is assertApiCredentials, called immediately after.
 * @param {import('../types').ProcessRequestPayload} jObject
 * @param {import('../config/configReader')} config
 */
function extractRequestFields(jObject, config) {
  return {
    actionCode: tokenToObjectString(requireToken(jObject, 'ActionCode')),
    companyNum: config.companyNum,
    viewName: tokenToObjectString(requireToken(jObject, 'ViewName')),
    clientIP: tokenToObjectString(requireToken(jObject, 'ClientIP')),
    jsonReq: tokenToString(requireToken(jObject, 'JsonReq')),
    notes: tokenToObjectString(requireToken(jObject, 'Notes'))
  };
}

/**
 * Verifies body credentials, but only for tenants that configure BOTH a username and
 * a password - a tenant with just one set skips the check entirely.
 *
 * CALL ORDER IS CONTRACTUAL: this must run AFTER extractRequestFields, because a body
 * missing a required member has to fail with the .NET null-reference error rather than
 * a credentials error. Swapping the two changes which message a caller receives.
 *
 * @param {import('../types').ProcessRequestPayload} jObject
 * @param {import('../config/configReader')} config
 */
function assertApiCredentials(jObject, config) {
  if (config.apiUserName === '' || config.apiPassword === '') return;

  const apiUserName = fixNullString(tokenToObjectString(requireToken(jObject, 'APILogin')));
  const apiPassword = fixNullString(tokenToObjectString(requireToken(jObject, 'APIPassword')));

  if (!(config.apiUserName === apiUserName && config.apiPassword === apiPassword)) {
    throw new Error(Messages.INVALID_CREDENTIALS);
  }
}

/**
 * Executes the full `POST /DBAPI/ProcessRequest` flow: IP gate, credential
 * check, stored-procedure dispatch, and marker logging, for an
 * already-resolved tenant `config`.
 * @param {import('../config/configReader')} config
 * @returns {Promise<string>} the response body text
 */
/** Enforces the tenant IP gate. Note `checkStarCondition` is true here, unlike the
 * diagnostic view's display-only call. */
function assertIpAllowed(config, observedClientIP) {
  if (!config.isIPWhitelisted(observedClientIP, true)) {
    throw new Error(`${Messages.BLACKLISTED_MESSAGE} [IP:${observedClientIP}]`);
  }
}

/**
 * Gated by enableLogging, unlike the numeric markers.
 *
 * DATA HANDLING: this writes the raw request body to the tenant audit file. For a
 * tenant that requires body credentials, that includes APILogin and APIPassword in
 * clear text. Preserved deliberately - redacting would change audit file contents
 * (guardrail G6). See S-9 in CODE_QUALITY_RECOMMENDATIONS.md. Currently latent:
 * company 101 has enableLogging=0, and the enableLogging=1 SELF block is shadowed
 * by the wildcard tenant.
 */
function logInboundRequest(audit, config, jsonRequest) {
  if (!config.enableLogging) return;
  audit.log(`REQUEST:${audit.lineBreak}${jsonRequest}`);
}

/** Gated by enableLogging. Writes the raw body again - same disclosure as above. */
function logExtractedFields(audit, config, jsonRequest, fields) {
  if (!config.enableLogging) return;
  audit.log(`jsonRequest:${audit.lineBreak}${jsonRequest}`);
  audit.log(`ActionCode:${audit.lineBreak}${fields.actionCode}`);
}

/** Markers 1: and 2: always fire; the RESPONSE block between them does not. */
function logOutboundResponse(audit, config, response) {
  audit.log(`1:${audit.lineBreak}`);
  if (config.enableLogging) {
    audit.log(`RESPONSE:${audit.lineBreak}${response}`);
  }
  audit.log(`2:${audit.lineBreak}`);
}

/** C# `Replace('\n', ' ')` removes LF only, leaving any preceding CR intact. */
function toResponseText(dbOutput) {
  return fixNullString(dbOutput).replace(/\n/g, ' ');
}

async function handleProcessRequest(config, jsonRequest, observedClientIP) {
  const audit = tenantAuditLog.createTenantLogger(config);

  // STEP ORDER IS CONTRACTUAL. The sequence below is observable through the tenant
  // audit file, and the numeric markers must interleave with the work exactly as
  // they do here: REQUEST -> IP gate -> -1: -> parse -> 0: -> extract -> credentials
  // -> jsonRequest/ActionCode -> DB -> 1: -> RESPONSE -> 2:.
  logInboundRequest(audit, config, jsonRequest);

  assertIpAllowed(config, observedClientIP);
  audit.log(`-1:${audit.lineBreak}`);

  // PRESERVED: a malformed body throws here and the V8 parser wording (e.g.
  // "Unexpected token } in JSON at position 12") becomes the HTTP 200 response body
  // via the controller's catch. Do NOT convert this to a 400 or wrap the message -
  // that is a wire-contract change. See S-2 in CODE_QUALITY_RECOMMENDATIONS.md.
  // Exact wording differs from the .NET original; MIGRATION_ANALYSIS.md notes that
  // runtime-specific exception text cannot be byte-identical.
  const jObject = JSON.parse(jsonRequest);
  audit.log(`0:${audit.lineBreak}`);

  const fields = extractRequestFields(jObject, config);
  assertApiCredentials(jObject, config);
  logExtractedFields(audit, config, jsonRequest, fields);

  const dbResult = await dbRepository.processDbRequest({
    connectionString: config.targetDBConnectionString,
    dbType: config.dbType,
    procName: config.procName,
    ...fields
  });

  const response = toResponseText(dbResult.output);

  logOutboundResponse(audit, config, response);

  return response;
}

/**
 * Handles the POST error path. Intentionally retains the source bug: if
 * `config` failed to construct (e.g. unknown tenant), dereferencing
 * `config.logType` below throws and the request escapes as a 500.
 */
function logProcessRequestFailure(error, config, jsonRequest, req) {
  // Dereferences `config` before any null check, deliberately - see the note above.
  const audit = tenantAuditLog.createTenantLogger(config);
  audit.log(`3:${audit.lineBreak}`);

  const dummyConfig = createConfigReader(LibraryConstants.SELF_SOURCE_WEBSITE_NAME);
  if (dummyConfig && dummyConfig.enableLogging) {
    const dummyAudit = tenantAuditLog.createTenantLogger(dummyConfig);
    dummyAudit.log(`ERRONEOUS-REQUEST:${dummyAudit.lineBreak}${jsonRequest}`);
    dummyAudit.logException(error, req);
  }
}

module.exports = { getDiagnosticSummary, handleProcessRequest, logProcessRequestFailure };
