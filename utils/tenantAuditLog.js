'use strict';

/**
 * Per-tenant audit log, carried over from the .NET source.
 *
 * Every function here REQUIRES a tenant `config` (it reads `logType`, `logPath`
 * and `companyNum`), and writes to `Log/<company>/<year>/<dd-MMM-yyyy>.<ext>`.
 * The framing, line-break characters and file layout are a contract - see
 * guardrail G6 in CODE_QUALITY_RECOMMENDATIONS.md. Do not reformat the output.
 *
 * For process lifecycle and unhandled request errors use `utils/appLogger.js`
 * instead; that logger takes no tenant and its format is free to change.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { LogType } = require('../constants');
const envConfig = require('../config/env');

const BORDER = '=====================================================================================';
const SEPARATOR = '-------------------------------------------------------------------------------------';

/**
 * Everything that varies by log type, in one place. Previously these three facts
 * were spread across getLineBreakCharacter, resolveTenantLogFile and writeTenant,
 * so adding a type meant editing three functions and hoping none was missed.
 *
 * Lookup is by `Number(logType)`, which is why any value coercing to 0 (including
 * '' and null) resolves to Html, and anything unrecognised falls back to Text.
 * That fallback is load-bearing - see the characterization tests.
 */
const LOG_TYPE_PROFILES = Object.freeze({
  [LogType.Html]: { lineBreak: '<br>', extension: '.html', sink: 'file' },
  [LogType.Text]: { lineBreak: '\n', extension: '.txt', sink: 'file' },
  [LogType.EventLog]: { lineBreak: '', extension: '.txt', sink: 'console' }
});

const DEFAULT_PROFILE = LOG_TYPE_PROFILES[LogType.Text];

function profileFor(logType) {
  return LOG_TYPE_PROFILES[Number(logType)] || DEFAULT_PROFILE;
}

function getLineBreakCharacter(logType) {
  return profileFor(logType).lineBreak;
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
  const ext = profileFor(config.logType).extension;
  return path.join(root, config.companyNum, String(date.getFullYear()), `${dateFileName(date)}${ext}`);
}

/**
 * Directories already created in this process.
 *
 * writeTenant used to call mkdirSync on EVERY log write, and a single request emits
 * up to eight. After the first write of the day the call is pure waste, and it is
 * synchronous, so it stalls the event loop for all concurrent requests. Only
 * successful creations are recorded, so a transient failure is retried next time.
 *
 * Growth is bounded by tenants x days, and the path is date-derived, so a
 * long-running process accumulates one entry per tenant per day.
 */
const ensuredDirectories = new Set();

function ensureDirectory(directory) {
  if (ensuredDirectories.has(directory)) return;
  fs.mkdirSync(directory, { recursive: true });
  ensuredDirectories.add(directory);
}

/**
 * Writes one framed message to the tenant's sink.
 *
 * OPERATIONAL HAZARD, preserved deliberately: this is synchronous and unguarded, so a
 * full disk or a permissions problem on the log directory throws. On the POST path
 * that turns a request which had already SUCCEEDED into a failure, and a throw from
 * the error-logging path escalates to a framework 500. In other words, logging can
 * take the API down. Making it tolerant would change which requests fail - see S-10
 * in CODE_QUALITY_RECOMMENDATIONS.md.
 */
function writeTenant(message, config) {
  if (profileFor(config.logType).sink === 'console') {
    // Send event log messages to the console when no event log is available.
    if (envConfig.eventLogFallback === 'stdout') console.log(message);
    else console.error(message);
    return;
  }

  const filename = resolveTenantLogFile(config);
  // Create the tenant log folder when it does not exist yet.
  ensureDirectory(path.dirname(filename));
  fs.appendFileSync(filename, `${message}${os.EOL}`, 'utf8');
}

function log(textToWrite, config) {
  const lb = getLineBreakCharacter(config.logType);
  const message = `${BORDER}${lb}Recording message at ${dotNetDateTime()}${lb}${textToWrite}${lb}${BORDER}${lb}`;
  writeTenant(message, config);
}

/**
 * Renders one labelled key/value block of the exception report.
 *
 * Two asymmetries in the original are deliberate and preserved:
 *  - the session block emits its "Total ..." line BEFORE the separator, while the
 *    form and query blocks emit it after (`totalBeforeSeparator`);
 *  - the session block's details label has no leading space, unlike the other two,
 *    which is why the caller passes the label verbatim.
 */
function formatSection({ values, totalLabel, detailsLabel, lb, totalBeforeSeparator = false }) {
  const keys = Object.keys(values);
  if (keys.length === 0) return '';

  const separator = `${lb}${SEPARATOR}${lb}`;
  const total = ` ${totalLabel} :${keys.length}${lb}`;

  let section = totalBeforeSeparator ? `${total}${separator}` : `${separator}${total}`;
  section += `${detailsLabel}${lb}`;
  keys.forEach((key, i) => {
    section += `${i + 1}) ${key} : ${values[key]}${lb}`;
  });
  return section;
}

/**
 * Renders form, query-string and session details for an exception report.
 *
 * DATA HANDLING: every value is written verbatim, so anything a caller put in a query
 * string or form field lands in the audit file. Preserved deliberately (guardrail G6);
 * see S-9 in CODE_QUALITY_RECOMMENDATIONS.md.
 */
function requestAndSessionDetails(req, lb) {
  if (!req) return '';

  // req.body is a string in this app (express.text), so the form block is normally
  // skipped; it stays for parity with the source's HttpRequest.Form handling.
  const form = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : null;

  return (
    formatSection({
      values: form || {},
      totalLabel: 'Total Form Variables',
      detailsLabel: ' Form Parameter Details are ',
      lb
    }) +
    formatSection({
      values: req.query || {},
      totalLabel: 'Total Query String Variables',
      detailsLabel: ' Query String Parameter Details are ',
      lb
    }) +
    formatSection({
      values: req.session || {},
      totalLabel: 'Total Session Variables',
      detailsLabel: 'Session Variable Details are ',
      lb,
      totalBeforeSeparator: true
    })
  );
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

/**
 * Binds a tenant `config` once and returns the three things callers actually need,
 * so request flows stop repeating
 * `Logger.log(`X:${Logger.getLineBreakCharacter(config.logType)}`, config)` at every
 * call site. Emits byte-identical output to the free functions below.
 *
 * @param {{logType: string|number, logPath?: string, companyNum: string}} config
 */
function createTenantLogger(config) {
  return {
    lineBreak: getLineBreakCharacter(config.logType),
    log: (textToWrite) => log(textToWrite, config),
    logException: (error, req) => logException(error, config, req)
  };
}

module.exports = {
  getLineBreakCharacter,
  resolveTenantLogFile,
  getErrorMessage,
  log,
  logException,
  createTenantLogger
};
