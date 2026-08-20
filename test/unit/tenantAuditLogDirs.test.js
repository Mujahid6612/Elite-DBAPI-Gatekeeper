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

test('a failed creation is not cached, so the next write retries', () => {
  const config = tempConfig();
  const original = fs.mkdirSync;
  fs.mkdirSync = () => {
    throw new Error('EACCES');
  };
  try {
    assert.throws(() => tenantAuditLog.log('x', config), { message: 'EACCES' });
  } finally {
    fs.mkdirSync = original;
  }

  // Retry now succeeds, proving the failure was not memoized.
  assert.doesNotThrow(() => tenantAuditLog.log('y', config));
  assert.ok(fs.readFileSync(tenantAuditLog.resolveTenantLogFile(config), 'utf8').includes('y'));
});
