'use strict';

/**
 * END-TO-END (in process) — the BlinkRide backend's request reaches MySQL through the
 * shipped config/tenants.jsonc.
 *
 * The client sends JsonReq with Source / Target (and its accessToken / accessKey) in `JHeader`;
 * the whole JsonReq must reach the procedure unchanged. `mysql2/promise` is faked, so this proves routing, dispatch and the response shape.
 */

process.env.ORACLE_USER = 'u';
process.env.ORACLE_PASSWORD = 'p';
process.env.ORACLE_CONNECTION = 'db';
process.env.DB_BR_USER = 'br';
process.env.DB_BR_PASSWORD = 'secret';
process.env.DB_GFT_USER = 'br';
process.env.DB_GFT_PASSWORD = 'secret';
process.env.DB_GFT_CONNECT_STRING = 'Server=db.example.com;Port=3306;Database=gft_dev';
process.env.DB_BR_CONNECT_STRING = 'Server=db.example.com;Port=3306;Database=br';
process.env.LOG_ROOT = require('os').tmpdir();

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Module = require('module');

const executed = [];
/** `database` each pool was created for, in creation order. */
const pools = [];
const fakeMysql = {
  createPool: (options) => {
    pools.push(options.database);
    return {
      getConnection: async () => ({
        execute: async (statement, values) => {
          executed.push({ sql: statement.sql, values });
          return [/SELECT @pjObj/.test(statement.sql) ? [{ response: '{"jHeader":{"responseCode":0}}' }] : []];
        },
        release: () => {}
      }),
      end: async () => {}
    };
  }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'mysql2/promise') return fakeMysql;
  return originalLoad.call(this, request, parent, isMain);
};

const app = require('../../app');

function post(port, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { port, method: 'POST', path: '/DBAPI/ProcessRequest', headers: { 'Content-Type': 'application/json' } },
      (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => resolve({ status: response.statusCode, text }));
      }
    );
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

function envelope(source, target) {
  return {
    ActionCode: 'DRV.S.LOGIN_DRIVER',
    ViewName: 'DRV.S.LOGIN_DRIVER',
    ClientIP: '1.2.3.4',
    JsonReq: {
      // What the backend adds so the Gatekeeper can route; its own jHeader is left as it was.
      JHeader: { Source: source, Target: target },
      jHeader: { source: 'driver-service', target: 'DBAPI', clientIP: '1.2.3.4' },
      jMetaData: {},
      jData: { P_ACTION_CODE: 'DRV.S.LOGIN_DRIVER', P_APP_NAME: 'driver-ios' }
    },
    Notes: ''
  };
}

test('a request with a routing JHeader routes to the MySQL block and returns the procedure output', async () => {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const { status, text } = await post(port, envelope('BRBackend', 'BRAPI'));

    assert.equal(status, 200);
    assert.equal(JSON.parse(text), '{"jHeader":{"responseCode":0}}');

    const call = executed.find((entry) => entry.sql.startsWith('CALL request_handler'));
    assert.ok(call, 'request_handler was called');
    assert.deepEqual(call.values, ['1.2.3.4', null, 'driver-ios', 'DRV.S.LOGIN_DRIVER']);

    const set = executed.find((entry) => entry.sql === 'SET @reqObj = ?');
    assert.equal(JSON.parse(set.values[0]).jHeader.source, 'driver-service');
    assert.deepEqual(JSON.parse(set.values[0]).JHeader, { Source: 'BRBackend', Target: 'BRAPI' });
  } finally {
    server.close();
    Module._load = originalLoad;
  }
});

test('an unknown source is refused rather than served', async () => {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const { text } = await post(port, envelope('Nobody', 'BRAPI'));
    assert.match(JSON.parse(text), /^Access Denied\./);
  } finally {
    server.close();
  }
});

test('one source reaches BlinkRide or GFT depending on the Target', async () => {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await post(port, envelope('AZSPostman', 'BRAPI'));
    await post(port, envelope('AZSPostman', 'GFTAPI'));
    // BRAPI's pool was already created by an earlier test in this file; GFT's is new.
    assert.ok(pools.includes('gft_dev'), `pools created for: ${pools.join(', ')}`);
    assert.ok(pools.includes('br'));
  } finally {
    server.close();
  }
});
