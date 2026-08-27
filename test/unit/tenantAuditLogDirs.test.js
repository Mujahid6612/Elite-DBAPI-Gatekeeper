'use strict';

/**
 * UNIT TEST — directory memoization (Phase 6, CQ-26).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tenantAuditLog = require('../../utils/tenantAuditLog');

function tempConfig() {
  return {
    companyNum: '101',
    logType: 1,
    logPath: fs.mkdtempSync(path.join(os.tmpdir(), 'dirs-'))
  };
}

test('mkdirSync runs once per directory, not once per write', () => {
  const config = tempConfig();
  const original = fs.mkdirSync;
  let calls = 0;
  fs.mkdirSync = (...args) => {
    calls += 1;
    return original(...args);
  };
  try {
    for (let i = 0; i < 8; i += 1) tenantAuditLog.log(`line ${i}`, config);
  } finally {
    fs.mkdirSync = original;
  }

  assert.equal(calls, 1, 'eight writes to one directory must trigger a single mkdirSync');
});

test('all eight lines are still written, in order', () => {
  const config = tempConfig();
  for (let i = 0; i < 8; i += 1) tenantAuditLog.log(`line ${i}`, config);

  const file = tenantAuditLog.resolveTenantLogFile(config);
  const written = fs.readFileSync(file, 'utf8');
  for (let i = 0; i < 8; i += 1) assert.ok(written.includes(`line ${i}`), `missing line ${i}`);
  assert.ok(written.indexOf('line 0') < written.indexOf('line 7'), 'append order lost');
});

test('a different tenant directory still gets created', () => {
  const first = tempConfig();
  const second = tempConfig();
  tenantAuditLog.log('a', first);
  tenantAuditLog.log('b', second);

  assert.ok(fs.existsSync(tenantAuditLog.resolveTenantLogFile(first)));
  assert.ok(fs.existsSync(tenantAuditLog.resolveTenantLogFile(second)));
});

test('a write failure is swallowed, not propagated into the request', () => {
  // CHANGED FROM THE ORIGINAL BEHAVIOUR (was S-10). This used to assert that the
  // failure THREW. It no longer does: an unwritable log directory must not turn a
  // request whose database call already succeeded into a 500. The detail is reported
  // through appLogger instead.
  const config = tempConfig();
  const original = fs.mkdirSync;
  fs.mkdirSync = () => {
    throw new Error('EACCES');
  };
  try {
    assert.doesNotThrow(() => tenantAuditLog.log('x', config), 'logging must not fail the caller');
  } finally {
    fs.mkdirSync = original;
  }

  // Retry still succeeds, proving the failure was not memoized by ensuredDirectories.
  assert.doesNotThrow(() => tenantAuditLog.log('y', config));
  assert.ok(fs.readFileSync(tenantAuditLog.resolveTenantLogFile(config), 'utf8').includes('y'));
});

test('a write failure still leaves the entry on stdout, so the record is not lost', () => {
  const config = tempConfig();
  const originalAppend = fs.appendFileSync;
  const originalLog = console.log;
  const captured = [];

  console.log = (line) => captured.push(String(line));
  fs.appendFileSync = () => {
    const error = new Error('EROFS: read-only file system');
    error.code = 'EROFS';
    throw error;
  };
  try {
    tenantAuditLog.log('payload-that-must-survive', config);
  } finally {
    fs.appendFileSync = originalAppend;
    console.log = originalLog;
  }

  assert.ok(
    captured.some((line) => line.includes('payload-that-must-survive')),
    'the audit entry must reach stdout when the file sink is unavailable'
  );
});
