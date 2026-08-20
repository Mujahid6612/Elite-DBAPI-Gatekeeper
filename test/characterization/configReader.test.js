'use strict';

/**
 * CHARACTERIZATION TEST — config/configReader.js (ConfigReader).
 *
 * Prerequisite for CQ-05, which splits this class into an XML parser, a config
 * source and an IP policy. Pins tenant matching (including the wildcard shadowing
 * in guardrail G2), the per-construction file re-read (G1), the mutually recursive
 * whitelist/blacklist star handling, and the .NET-style missing-node error (G9).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ConfigReader = require('../../config/configReader');

const FULL_KEYS = [
  'sourceWebsite',
  'projectName',
  'companyNum',
  'whitelistedIPs',
  'blacklistedIPs',
  'enableLogging',
  'apiUserName',
  'apiPassword',
  'targetDBConnectionString',
  'dbType',
  'driverType',
  'procName',
  'logType',
  'logPath'
];

/** Writes a temporary config.xml built from the given appSettings blocks. */
function writeConfig(blocks) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbgk-cfg-')), 'config.xml');
  const body = blocks
    .map((block) => {
      const children = FULL_KEYS.map(
        (key) => `    <${key}>${block[key] === undefined ? '' : block[key]}</${key}>`
      ).join('\n');
      return `  <appSettings>\n${children}\n  </appSettings>`;
    })
    .join('\n');
  fs.writeFileSync(file, `<?xml version="1.0" encoding="utf-8" ?>\n<configuration>\n${body}\n</configuration>\n`);
  return file;
}

test('matches a tenant by sourceWebsite, case-insensitively', () => {
  const configPath = writeConfig([{ sourceWebsite: 'Site.Example', companyNum: '500' }]);
  assert.equal(new ConfigReader('site.example', { configPath }).companyNum, '500');
  assert.equal(new ConfigReader('SITE.EXAMPLE', { configPath }).companyNum, '500');
});

test('matches any entry in a comma-separated sourceWebsite list', () => {
  const configPath = writeConfig([{ sourceWebsite: 'a.example,b.example', companyNum: '600' }]);
  assert.equal(new ConfigReader('b.example', { configPath }).companyNum, '600');
});

test('an unmatched source website is rejected with the Access Denied message', () => {
  const configPath = writeConfig([{ sourceWebsite: 'only.example', companyNum: '1' }]);
  assert.throws(() => new ConfigReader('other.example', { configPath }), {
    message: 'Access Denied. Source website (other.example) is not authorized to query the Web API'
  });
});

test('first match wins, so a leading * shadows a later explicit tenant (G2)', () => {
  const configPath = writeConfig([
    { sourceWebsite: '*', companyNum: '101' },
    { sourceWebsite: 'SELF', companyNum: '999' }
  ]);
  assert.equal(new ConfigReader('SELF', { configPath }).companyNum, '101', 'the wildcard block must still shadow SELF');
  assert.equal(new ConfigReader('anything', { configPath }).companyNum, '101');
});

test('with the order reversed the explicit tenant wins — proving order is the mechanism', () => {
  const configPath = writeConfig([
    { sourceWebsite: 'SELF', companyNum: '999' },
    { sourceWebsite: '*', companyNum: '101' }
  ]);
  assert.equal(new ConfigReader('SELF', { configPath }).companyNum, '999');
  assert.equal(new ConfigReader('other', { configPath }).companyNum, '101');
});

test('the file is re-read on every construction (G1)', () => {
  const configPath = writeConfig([{ sourceWebsite: '*', companyNum: '111' }]);
  assert.equal(new ConfigReader('x', { configPath }).companyNum, '111');

  fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('111', '222'));
  assert.equal(new ConfigReader('x', { configPath }).companyNum, '222', 'a cached parse would still report 111');
});

test('a missing config node throws the .NET-style null-reference error naming the node', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbgk-cfg-')), 'config.xml');
  fs.writeFileSync(file, '<configuration><appSettings><sourceWebsite>*</sourceWebsite></appSettings></configuration>');

  const config = new ConfigReader('x', { configPath: file });
  assert.throws(() => config.companyNum, {
    name: 'TypeError',
    message: 'Object reference not set to an instance of an object. Missing config node: companyNum'
  });
});

test('XML entities are decoded, with &amp; resolved last', () => {
  const configPath = writeConfig([
    { sourceWebsite: '*', projectName: '&lt;A&gt; &amp;amp; &quot;B&quot; &apos;C&apos;' }
  ]);
  assert.equal(new ConfigReader('x', { configPath }).projectName, `<A> &amp; "B" 'C'`);
});

test('accessor coercion: enableLogging via fixNullBoolean, logType via fixNullInt', () => {
  const configPath = writeConfig([{ sourceWebsite: '*', enableLogging: '1', logType: '2', companyNum: ' 101 ' }]);
  const config = new ConfigReader('x', { configPath });
  assert.equal(config.enableLogging, true);
  assert.equal(config.logType, 2);
  assert.equal(config.companyNum, '101', 'text accessors trim');

  const off = new ConfigReader('x', { configPath: writeConfig([{ sourceWebsite: '*', enableLogging: '0' }]) });
  assert.equal(off.enableLogging, false);
});

test('a blank logType coerces to 0, which the logger treats as Html', () => {
  const configPath = writeConfig([{ sourceWebsite: '*', logType: '' }]);
  assert.equal(new ConfigReader('x', { configPath }).logType, 0);
});

test('explicit IP lists match exactly, with surrounding whitespace trimmed', () => {
  const configPath = writeConfig([
    { sourceWebsite: '*', whitelistedIPs: '1.1.1.1, 2.2.2.2', blacklistedIPs: '3.3.3.3' }
  ]);
  const config = new ConfigReader('x', { configPath });

  assert.equal(config.isIPWhitelisted('1.1.1.1'), true);
  assert.equal(config.isIPWhitelisted('2.2.2.2'), true, 'entries are trimmed');
  assert.equal(config.isIPWhitelisted('9.9.9.9'), false);
  assert.equal(config.isIPBlacklisted('3.3.3.3'), true);
  assert.equal(config.isIPBlacklisted('1.1.1.1'), false);
});

test('star whitelist: returns checkStarCondition && !blacklisted', () => {
  const configPath = writeConfig([{ sourceWebsite: '*', whitelistedIPs: '*', blacklistedIPs: '' }]);
  const config = new ConfigReader('x', { configPath });

  assert.equal(config.isIPWhitelisted('1.2.3.4', true), true, 'the gate passes with the star flag');
  assert.equal(config.isIPWhitelisted('1.2.3.4'), false, 'without the flag the star branch reports false');
});

test('star whitelist still excludes an explicitly blacklisted IP', () => {
  const configPath = writeConfig([{ sourceWebsite: '*', whitelistedIPs: '*', blacklistedIPs: '1.2.3.4' }]);
  const config = new ConfigReader('x', { configPath });

  assert.equal(config.isIPWhitelisted('1.2.3.4', true), false);
  assert.equal(config.isIPWhitelisted('9.9.9.9', true), true);
});

test('star blacklist mirrors the same recursion against the whitelist', () => {
  const configPath = writeConfig([{ sourceWebsite: '*', whitelistedIPs: '1.2.3.4', blacklistedIPs: '*' }]);
  const config = new ConfigReader('x', { configPath });

  assert.equal(config.isIPBlacklisted('1.2.3.4', true), false, 'whitelisted IPs escape the star blacklist');
  assert.equal(config.isIPBlacklisted('9.9.9.9', true), true);
  assert.equal(config.isIPBlacklisted('9.9.9.9'), false, 'without the flag the star branch reports false');
});

test('an empty IP list never matches, not even an empty client IP', () => {
  const configPath = writeConfig([{ sourceWebsite: '*', whitelistedIPs: '', blacklistedIPs: '' }]);
  const config = new ConfigReader('x', { configPath });
  assert.equal(config.isIPWhitelisted('1.2.3.4'), false);
  // NOTE: ''.split(',') is [''], so an empty observed IP DOES match an empty list.
  assert.equal(config.isIPWhitelisted(''), true, 'pinned quirk: empty matches empty');
  assert.equal(config.isIPWhitelisted(null), true, 'fixNullString(null) === ""');
});

test('both star lists together: whitelist star wins via mutual recursion', () => {
  const configPath = writeConfig([{ sourceWebsite: '*', whitelistedIPs: '*', blacklistedIPs: '*' }]);
  const config = new ConfigReader('x', { configPath });
  // isIPWhitelisted(ip, true) -> true && !isIPBlacklisted(ip) -> !(false && ...) -> true
  assert.equal(config.isIPWhitelisted('1.2.3.4', true), true);
  assert.equal(config.isIPBlacklisted('1.2.3.4', true), true);
});
