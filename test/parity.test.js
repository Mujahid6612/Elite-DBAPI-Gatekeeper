'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const ConfigReader = require('../config/tenantConfig');
const { decryptString, encryptString } = require('../utils/encryption');
const { unwrapFromBodyString } = require('../utils/webApiCompat');
const { parseAdoConnectionString } = require('../repositories/adoConnectionString');

const TENANT_CIPHER = 'GrfZ5a946KcrALKS6s3PTE2ip0p6DAqY1j/kQuRBhDNqxa8qHzyXoE8/OF8yc3B6OLyybZ9R03s1nmimGIz/YQ==';
const WEBCONFIG_CIPHER = 'GrfZ5a946KcrALKS6s3PTNWHlYOtalsM4dkfpn4Kck04q3Dw5LNBReqampae4DgfqI/6Ak1tg+DSsp5WFnYLZQ==';
const EXPECTED_SHA256 = [
  '8f3c3b4582c5ef3ae6cdafc047e5b2007ace21ebfe717f43947abeafccc20045',
  'dc13bc3b67256c9ca3923a8261ef694c9436216f5ac1a4231f0cad61a5c3fa32'
];

function sha(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }

test('legacy PasswordDeriveBytes AES decrypt matches both real project ciphertexts', () => {
  const p1 = decryptString(TENANT_CIPHER);
  const p2 = decryptString(WEBCONFIG_CIPHER);
  assert.equal(sha(p1), EXPECTED_SHA256[0]);
  assert.equal(sha(p2), EXPECTED_SHA256[1]);
  assert.equal(encryptString(p1), TENANT_CIPHER);
  assert.equal(encryptString(p2), WEBCONFIG_CIPHER);
});

test('ConfigReader reloads and wildcard tenant is first match even for SELF', () => {
  const configPath = path.join(__dirname, '..', 'config.xml');
  const normal = new ConfigReader('anything.example', { configPath });
  const self = new ConfigReader('SELF', { configPath });
  assert.equal(normal.companyNum, '101');
  assert.equal(self.companyNum, '101');
  assert.equal(self.sourceWebsite, '*');
});

test('star whitelist permits callers when blacklist list is empty', () => {
  const config = new ConfigReader('localhost');
  assert.equal(config.isIPWhitelisted('127.0.0.1', true), true);
  assert.equal(config.isIPWhitelisted('127.0.0.1'), false);
  assert.equal(config.isIPBlacklisted('127.0.0.1'), false);
});

test('FromBody string compatibility handles legacy and direct JSON bodies', () => {
  const body = '{"ActionCode":"A"}';
  assert.equal(unwrapFromBodyString(`'${body}'`), body);
  assert.equal(unwrapFromBodyString(JSON.stringify(body)), body);
  assert.equal(unwrapFromBodyString(body), body);
});

test('ADO connection string parser keeps embedded value text', () => {
  const parsed = parseAdoConnectionString('Data Source=Alias;user id=U;password=P;');
  assert.equal(parsed['data source'], 'Alias');
  assert.equal(parsed['user id'], 'U');
  assert.equal(parsed.password, 'P');
});
