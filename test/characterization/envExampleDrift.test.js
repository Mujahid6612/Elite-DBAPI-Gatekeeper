'use strict';

/**
 * GUARD TEST — .env.example must document every environment variable the app reads.
 *
 * CQ-04 existed because ORACLE_USER / ORACLE_PASSWORD / ORACLE_CONNECTION were
 * required at runtime but missing from the template, so the documented
 * `cp .env.example .env && npm start` flow could not work. This test fails the
 * build if that drift ever returns.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..', '..');
// `scripts/` is dev-only tooling whose process.env reads are stub knobs, not
// application configuration, so it is excluded from the drift check by design.
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'Log', '.github', 'scripts']);

function collectSourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectSourceFiles(path.join(dir, entry.name), found);
    } else if (entry.name.endsWith('.js') && entry.name !== 'eslint.config.js') {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

function environmentKeysReadBySource() {
  const keys = new Set();
  for (const file of collectSourceFiles(projectRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) keys.add(match[1]);
  }
  return keys;
}

function keysDocumentedInExample() {
  const keys = new Set();
  const template = fs.readFileSync(path.join(projectRoot, '.env.example'), 'utf8');
  for (const line of template.split('\n')) {
    const match = /^([A-Z0-9_]+)=/.exec(line.trim());
    if (match) keys.add(match[1]);
  }
  return keys;
}

test('every process.env key read by the app is documented in .env.example', () => {
  const documented = keysDocumentedInExample();
  const undocumented = [...environmentKeysReadBySource()].filter((key) => !documented.has(key)).sort();

  assert.deepEqual(undocumented, [], `undocumented environment variables: ${undocumented.join(', ')}`);
});

test('.env.example documents no keys the app never reads', () => {
  const read = environmentKeysReadBySource();
  const unused = [...keysDocumentedInExample()].filter((key) => !read.has(key)).sort();

  assert.deepEqual(unused, [], `documented but never read: ${unused.join(', ')}`);
});

test('the required Oracle credentials are present as explicit keys (CQ-04 regression guard)', () => {
  const documented = keysDocumentedInExample();
  for (const key of ['ORACLE_USER', 'ORACLE_PASSWORD', 'ORACLE_CONNECTION']) {
    assert.ok(documented.has(key), `${key} missing from .env.example`);
  }
});
