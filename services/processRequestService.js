'use strict';

const { createConfigReader } = require('../config/configReaderProvider');
const tenantAuditLog = require('../utils/tenantAuditLog');
const dbRepository = require('../repositories/dbRepository');
const { Messages, LibraryConstants } = require('../constants');
const { fixNullString } = require('../utils/nullHelpers');
const { redactSecrets } = require('../utils/logRedaction');
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
 * Returns the `JsonReq.JHeader` object of a request body, or null when the body does
 * not carry one. `JsonReq` is accepted either as a nested object (what the React
 * Native client sends) or as a JSON string (what a hand-rolled client may send, since
 * parsers/requestTokenParser.js renders it as text either way). A `JsonReq` that does
 * not parse is simply treated as carrying no header - reporting that here would
 * replace the credentials error with a parser error.
 */
function requestHeader(jObject) {
  let jsonReq = jObject ? jObject.JsonReq : null;

  if (typeof jsonReq === 'string') {
    try {
      jsonReq = JSON.parse(jsonReq);
    } catch {
      return null;
    }
  }

  if (!jsonReq || typeof jsonReq !== 'object') return null;
  const header = jsonReq.JHeader;
  return header && typeof header === 'object' ? header : null;
}

/**
 * Reads a credential member from either placement the wire format actually uses.
 *
 * FIXED: the check previously looked ONLY at the TOP LEVEL of the body, but the
 * EliteApp client puts `APILogin`/`APIPassword` inside `JsonReq.JHeader`
 * (src/Services/apiService.ts). The two never met. That went unnoticed only because
 * both supplied tenants leave `apiUserName`/`apiPassword` blank in config.xml, so the
 * caller below short-circuits and the check never runs. The moment a tenant enabled
 * credentials - the exact moment the control is supposed to start protecting
 * something - every request from the app would have failed with the .NET
 * null-reference error instead of authenticating.
 *
 * Top level is tried FIRST so existing top-level callers, and the characterization
 * tests that pin them, are completely unaffected. When neither placement carries the
 * member the lookup falls back to the top-level `requireToken`, so an absent
 * credential still produces the original null-reference message verbatim.
 */
function requireCredential(jObject, key) {
  if (Object.prototype.hasOwnProperty.call(jObject, key)) return requireToken(jObject, key);

  const header = requestHeader(jObject);
  if (header && Object.prototype.hasOwnProperty.call(header, key)) return requireToken(header, key);

  return requireToken(jObject, key);
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

  const apiUserName = fixNullString(tokenToObjectString(requireCredential(jObject, 'APILogin')));
  const apiPassword = fixNullString(tokenToObjectString(requireCredential(jObject, 'APIPassword')));

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
 * DATA HANDLING: this writes the request body to the tenant audit file, with
 * `APIPassword` masked by utils/logRedaction.js. `APILogin` is kept, because
 * identifying the caller is the purpose of an audit record.
 *
 * The masking is a deliberate departure from source parity (guardrail G6, S-9):
 * the .NET original wrote the body untouched. That was tolerable only while this
 * path was dead - company 101 had enableLogging=0 and the enableLogging=1 SELF
 * block was shadowed by the wildcard tenant, so nothing was ever written. Both are
 * now fixed, which turns "no requests logged" into "every request logged", and
 * writing a live credential to disk on every call is not an acceptable default.
 */
function logInboundRequest(audit, config, jsonRequest) {
  if (!config.enableLogging) return;
  audit.log(`REQUEST:${audit.lineBreak}${redactSecrets(jsonRequest)}`);
}

/** Gated by enableLogging. Writes the body again - same redaction applies. */
function logExtractedFields(audit, config, jsonRequest, fields) {
  if (!config.enableLogging) return;
  audit.log(`jsonRequest:${audit.lineBreak}${redactSecrets(jsonRequest)}`);
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
    dummyAudit.log(`ERRONEOUS-REQUEST:${dummyAudit.lineBreak}${redactSecrets(jsonRequest)}`);
    dummyAudit.logException(error, req);
  }
}

module.exports = { getDiagnosticSummary, handleProcessRequest, logProcessRequestFailure };
