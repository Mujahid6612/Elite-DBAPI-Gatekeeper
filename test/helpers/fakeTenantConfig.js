'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Builds a duck-typed stand-in for a ConfigReader instance, backed by a throwaway
 * log directory. Characterization tests use this instead of a real ConfigReader so
 * they never touch config/tenants.jsonc and never write into the project's own Log/ tree.
 */
function makeFakeConfig(overrides = {}) {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dbgk-log-'));
  return {
    logRoot,
    config: {
      sourceWebsite: 'test.example',
      projectName: 'Test Project',
      companyNum: '101',
      whitelistedIPs: '*',
      blacklistedIPs: '',
      enableLogging: true,
      apiUserName: '',
      apiPassword: '',
      dbType: '2',
      driverType: '0',
      procName: 'REQUEST_HANDLER.ACTIONS',
      logType: 1,
      logPath: logRoot,
      targetDBConnectionString: 'Data Source=FAKE;user id=U;password=P;',
      isIPWhitelisted: () => true,
      isIPBlacklisted: () => false,
      ...overrides
    }
  };
}

/** Reads whatever the tenant logger wrote for `config`, or '' when nothing was written. */
function readTenantLog(logRoot, companyNum = '101', date = new Date()) {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(date.getDate()).padStart(2, '0');
  const stem = `${day}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`;
  const dir = path.join(logRoot, companyNum, String(date.getFullYear()));
  for (const ext of ['.txt', '.html']) {
    const file = path.join(dir, `${stem}${ext}`);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  return '';
}

module.exports = { makeFakeConfig, readTenantLog };
