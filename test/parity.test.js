'use strict';

const test = require('node:test');

/**
 * The passphrase the ORIGINAL .NET app used, kept here only to prove the migrated
 * cipher still reproduces its output byte for byte. It is no longer a default
 * anywhere: config/tenants.jsonc is decrypted with CONFIG_ENCRYPTION_KEY from the
 * environment, precisely because this value is public.
 */
const LEGACY_PASSPHRASE = 'SoundViewTechEncryption';
const assert = require('node:assert/strict');
const crypto = require('crypto');
const tenantRegistry = require('../config/tenantRegistry');
const Tenant = require('../config/tenant');
const { decryptString, encryptString } = require('../utils/encryption');
const { unwrapFromBodyString } = require('../utils/webApiCompat');
const { parseAdoConnectionString } = require('../repositories/adoConnectionString');

const TENANT_CIPHER = 'GrfZ5a946KcrALKS6s3PTE2ip0p6DAqY1j/kQuRBhDNqxa8qHzyXoE8/OF8yc3B6OLyybZ9R03s1nmimGIz/YQ==';
const WEBCONFIG_CIPHER = 'GrfZ5a946KcrALKS6s3PTNWHlYOtalsM4dkfpn4Kck04q3Dw5LNBReqampae4DgfqI/6Ak1tg+DSsp5WFnYLZQ==';
const EXPECTED_SHA256 = [
  '8f3c3b4582c5ef3ae6cdafc047e5b2007ace21ebfe717f43947abeafccc20045',
  'dc13bc3b67256c9ca3923a8261ef694c9436216f5ac1a4231f0cad61a5c3fa32'
];

function sha(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

test('legacy PasswordDeriveBytes AES decrypt matches both real project ciphertexts', () => {
  const p1 = decryptString(TENANT_CIPHER, LEGACY_PASSPHRASE);
  const p2 = decryptString(WEBCONFIG_CIPHER, LEGACY_PASSPHRASE);
  assert.equal(sha(p1), EXPECTED_SHA256[0]);
  assert.equal(sha(p2), EXPECTED_SHA256[1]);
  assert.equal(encryptString(p1, LEGACY_PASSPHRASE), TENANT_CIPHER);
  assert.equal(encryptString(p2, LEGACY_PASSPHRASE), WEBCONFIG_CIPHER);
});

test('the default block serves pre-parse logging, and Source/Target select the database', () => {
  // REPLACES the old Host-vs-sourceWebsite ordering test. There is no Host matching
  // any more: config/tenants.jsonc has one `default` block for the work that happens
  // BEFORE the body is parsed (the REQUEST audit line and the IP gate), and the
  // database blocks are selected by the Source/Target the client actually sends.
  const fallback = tenantRegistry.defaultTenant();
  assert.equal(fallback.companyNum, '999');
  assert.equal(fallback.enableLogging, true, 'exception reports are gated on this');

  const matched = tenantRegistry.resolveTenant('NativeApp', 'DBAPI');
  assert.equal(matched.companyNum, '101');
  assert.equal(matched.procName, 'REQUEST_HANDLER.ACTIONS');

  // MANY-TO-ONE: a second source reaches the very same block.
  assert.equal(tenantRegistry.resolveTenant('WebApp', 'DBAPI'), matched);

  // And an unconfigured pair is refused rather than falling back to some default.
  assert.equal(tenantRegistry.resolveTenant('Unconfigured', 'DBAPI'), null);
});

test('star whitelist permits callers when blacklist list is empty', () => {
  const config = new Tenant({ whitelistedIPs: '*', blacklistedIPs: '' });
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
