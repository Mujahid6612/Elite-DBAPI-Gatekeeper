'use strict';

/**
 * CHARACTERIZATION TEST — utils/tenantAuditLog.js (the per-tenant audit log).
 *
 * The bytes written here are a contract: the log file layout and message framing
 * were carried over from the .NET source (guardrail G6). CQ-09, CQ-10, CQ-13 and
 * CQ-26 all refactor this module and must not change a single byte of output.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tenantAuditLog = require('../../utils/tenantAuditLog');
const envConfig = require('../../config/env');
const { LogType } = require('../../constants');
const { makeFakeConfig, readTenantLog } = require('../helpers/fakeTenantConfig');

const BORDER = '='.repeat(85);

test('BORDER is 85 equals signs — pinned because it frames every message', () => {
  const { config, logRoot } = makeFakeConfig({ logType: LogType.Text });
  tenantAuditLog.log('x', config);
  const written = readTenantLog(logRoot);
  assert.ok(written.startsWith(BORDER), 'message does not start with the 85-char border');
});

test('getLineBreakCharacter across every log type and malformed input', () => {
  assert.equal(tenantAuditLog.getLineBreakCharacter(LogType.Html), '<br>'); // 0
  assert.equal(tenantAuditLog.getLineBreakCharacter(LogType.Text), '\n'); // 1
  assert.equal(tenantAuditLog.getLineBreakCharacter(LogType.EventLog), ''); // 2
  assert.equal(tenantAuditLog.getLineBreakCharacter('0'), '<br>');
  assert.equal(tenantAuditLog.getLineBreakCharacter('1'), '\n');
  assert.equal(tenantAuditLog.getLineBreakCharacter('2'), '');
  // Values that Number() coerces to 0 are treated as Html. This is why the SELF
  // tenant's blank <logType></logType> would silently log as HTML rather than text.
  assert.equal(tenantAuditLog.getLineBreakCharacter(''), '<br>', "Number('') === 0 === LogType.Html");
  assert.equal(tenantAuditLog.getLineBreakCharacter(null), '<br>', 'Number(null) === 0 === LogType.Html');
  assert.equal(tenantAuditLog.getLineBreakCharacter([]), '<br>', 'Number([]) === 0 === LogType.Html');
  // Values that coerce to NaN or to an unknown number fall through to '\n'.
  assert.equal(tenantAuditLog.getLineBreakCharacter(3), '\n');
  assert.equal(tenantAuditLog.getLineBreakCharacter('abc'), '\n');
  assert.equal(tenantAuditLog.getLineBreakCharacter(undefined), '\n');
  assert.equal(tenantAuditLog.getLineBreakCharacter({}), '\n');
});

test('resolveTenantLogFile builds <root>/<company>/<year>/<dd-MMM-yyyy>.<ext>', () => {
  const date = new Date(2026, 7, 19); // 19 Aug 2026
  const base = { companyNum: '101', logType: LogType.Text, logPath: '/var/logs' };

  assert.equal(
    tenantAuditLog.resolveTenantLogFile(base, date),
    path.join('/var/logs', '101', '2026', '19-Aug-2026.txt')
  );

  assert.equal(
    tenantAuditLog.resolveTenantLogFile({ ...base, logType: LogType.Html }, date),
    path.join('/var/logs', '101', '2026', '19-Aug-2026.html'),
    'logType=0 (Html) selects the .html extension'
  );
});

test('resolveTenantLogFile strips the ~/ and ~\\ prefixes and resolves relative to projectRoot', () => {
  const date = new Date(2026, 0, 5); // 05 Jan 2026
  const base = { companyNum: '999', logType: LogType.Text };

  const expected = path.join(envConfig.projectRoot, 'Log', '999', '2026', '05-Jan-2026.txt');
  assert.equal(tenantAuditLog.resolveTenantLogFile({ ...base, logPath: '~/Log' }, date), expected);
  assert.equal(tenantAuditLog.resolveTenantLogFile({ ...base, logPath: '~\\Log' }, date), expected);
  assert.equal(tenantAuditLog.resolveTenantLogFile({ ...base, logPath: 'Log' }, date), expected);
  // Empty/missing logPath defaults to '~/Log' -> the same resolved location.
  assert.equal(tenantAuditLog.resolveTenantLogFile({ ...base, logPath: '' }, date), expected);
});

test('log() writes the exact border/timestamp/body framing, then the platform EOL', () => {
  const { config, logRoot } = makeFakeConfig({ logType: LogType.Text });
  tenantAuditLog.log('HELLO', config);

  const written = readTenantLog(logRoot);
  const pattern = new RegExp(
    `^${BORDER}\\nRecording message at (.+)\\nHELLO\\n${BORDER}\\n${os.EOL === '\r\n' ? '\\r\\n' : '\\n'}$`
  );
  assert.match(written, pattern, `unexpected framing:\n${JSON.stringify(written)}`);
});

test('log() uses <br> framing (not newlines) for Html tenants', () => {
  const { config, logRoot } = makeFakeConfig({ logType: LogType.Html });
  tenantAuditLog.log('-1:<br>', config);

  const written = readTenantLog(logRoot);
  assert.ok(written.startsWith(`${BORDER}<br>Recording message at `), 'missing <br> framing');
  assert.ok(written.includes(`<br>-1:<br><br>${BORDER}<br>`), 'unexpected body framing');
});

test('log() appends — repeated calls accumulate in one file, in call order', () => {
  const { config, logRoot } = makeFakeConfig({ logType: LogType.Text });
  tenantAuditLog.log('FIRST', config);
  tenantAuditLog.log('SECOND', config);

  const written = readTenantLog(logRoot);
  assert.ok(written.indexOf('FIRST') < written.indexOf('SECOND'), 'append order not preserved');
  assert.equal(written.match(new RegExp(BORDER, 'g')).length, 4, 'expected two framed messages');
});

test('EventLog tenants write to the console, never to disk', () => {
  const { config, logRoot } = makeFakeConfig({ logType: LogType.EventLog });
  const captured = [];
  const originalError = console.error;
  console.error = (msg) => captured.push(msg);
  try {
    tenantAuditLog.log('EVENT', config);
  } finally {
    console.error = originalError;
  }

  assert.equal(captured.length, 1, 'expected exactly one console.error call');
  assert.ok(captured[0].includes('EVENT'));
  // logType=2 yields an empty line-break character, so everything is on one line.
  assert.ok(captured[0].startsWith(`${BORDER}Recording message at `));
  assert.equal(fs.existsSync(path.join(logRoot, '101')), false, 'EventLog must not create files');
});

test('getErrorMessage lays out Type/Original Message/Source/Stack Trace in order', () => {
  const { config } = makeFakeConfig({ logType: LogType.Text });
  const error = new TypeError('boom');
  error.stack = 'STACK-LINE';

  const message = tenantAuditLog.getErrorMessage(error, config, null);
  const expected = `${BORDER}\n` + ` Exception Occured at : `;
  assert.ok(message.startsWith(expected), 'unexpected header');
  assert.ok(message.includes('\nType :TypeError\n'));
  assert.ok(message.includes('\nOriginal Message : boom\n'));
  assert.ok(message.includes('\nSource :\n'));
  assert.ok(message.includes('\nStack Trace :STACK-LINE\n'));
  assert.ok(message.endsWith(`${BORDER}\n`));
});

test('getErrorMessage tolerates a null error and defaults Type to Error', () => {
  const { config } = makeFakeConfig({ logType: LogType.Text });
  const message = tenantAuditLog.getErrorMessage(null, config, null);
  assert.ok(message.includes('\nType :Error\n'));
  assert.ok(message.includes('\nOriginal Message : \n'));
});

test('getErrorMessage renders query-string details but skips a string req.body', () => {
  const { config } = makeFakeConfig({ logType: LogType.Text });
  // req.body is a string in this app (express.text), so the form block is skipped.
  const req = { body: '{"ActionCode":"A"}', query: { RESP: 'JSON', ACID: 'AA1' } };

  const message = tenantAuditLog.getErrorMessage(new Error('e'), config, req);
  assert.equal(message.includes('Total Form Variables'), false, 'string body must not render as a form');
  assert.ok(message.includes(' Total Query String Variables :2\n'));
  assert.ok(message.includes('1) RESP : JSON\n'));
  assert.ok(message.includes('2) ACID : AA1\n'));
});

test('getErrorMessage renders the session block with its distinct header ordering', () => {
  const { config } = makeFakeConfig({ logType: LogType.Text });
  const req = { body: null, query: {}, session: { userId: 'u1' } };

  const message = tenantAuditLog.getErrorMessage(new Error('e'), config, req);
  // NOTE the asymmetry: the session block emits its "Total ..." line BEFORE the
  // separator, whereas the form and query blocks emit it after. CQ-13 must keep this.
  const sessionIndex = message.indexOf(' Total Session Variables :1');
  const separatorIndex = message.indexOf('---', sessionIndex);
  assert.ok(sessionIndex !== -1, 'session block missing');
  assert.ok(sessionIndex < separatorIndex, 'session header ordering quirk was not preserved');
  assert.ok(message.includes('1) userId : u1'));
});

test('getErrorMessage returns no request detail section when req is absent', () => {
  const { config } = makeFakeConfig({ logType: LogType.Text });
  const message = tenantAuditLog.getErrorMessage(new Error('e'), config, null);
  assert.equal(message.includes('Total Query String Variables'), false);
  assert.equal(message.includes('Total Session Variables'), false);
});

test('logException writes getErrorMessage output through the same tenant sink', () => {
  const { config, logRoot } = makeFakeConfig({ logType: LogType.Text });
  const error = new Error('written-to-disk');
  tenantAuditLog.logException(error, config, null);

  const written = readTenantLog(logRoot);
  assert.ok(written.includes('Original Message : written-to-disk'));
  assert.ok(written.includes('Exception Occured at :'));
});
