'use strict';

/**
 * UNIT TEST — BODY_LIMIT wiring (Phase 3, CQ-46).
 *
 * The limit was previously hardcoded to '2mb' in app.js. It is now sourced from
 * config/env.js with the same default. This proves the value is actually applied,
 * and pins what an over-limit request currently returns.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BODY_LIMIT = '10b';
process.env.LOG_LEVEL = 'silent';

const envConfig = require('../../config/env');
const app = require('../../app');
const { withServer, request } = require('../helpers/httpClient');

test('the override took effect', () => {
  assert.equal(envConfig.bodyLimit, '10b');
});

test('a body over BODY_LIMIT is rejected, proving the value is wired into express.text', async () => {
  await withServer(app, async (port) => {
    const res = await request(port, {
      method: 'POST',
      path: '/DBAPI/ProcessRequest',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(500)
    });

    // PINNED: the response is 500, not 413. middleware/errorHandler.js returns 500
    // for every unhandled error and ignores err.status, which express.text sets to
    // 413 for an over-limit body. Honouring that status would be a behavior change
    // and is deliberately NOT done here.
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.body), { Message: 'An error has occurred.' });
  });
});

test('a body under BODY_LIMIT is still processed normally', async () => {
  await withServer(app, async (port) => {
    const res = await request(port, { path: '/DBAPI/ProcessRequest' });
    assert.equal(res.status, 200);
    assert.equal(res.body, '["Welcome to DB API"]');
  });
});
