'use strict';

/**
 * CHARACTERIZATION TEST — end-to-end HTTP contract for all eight routes.
 *
 * Pins status codes, content types and exact bodies (guardrails G3, G4, G11).
 * The tenant logger is stubbed throughout so these tests never write into the
 * project's Log/ tree; log sequencing is covered in processRequestService.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// The FlightView 500 case deliberately triggers the error handler, which logs to
// stderr (CQ-20). Silence the application logger so that expected failure does not
// look like a broken test run. Must precede the app require: config/env.js freezes
// its values at load. Behavior under a normal LOG_LEVEL is covered in test/unit/.
process.env.LOG_LEVEL = 'silent';

const app = require('../../app');
const tenantAuditLog = require('../../utils/tenantAuditLog');
const dbRepository = require('../../repositories/dbRepository');
const { withServer, request } = require('../helpers/httpClient');

/** Silences the tenant audit log for the duration of `run`. */
async function withSilencedTenantLog(run) {
  const originals = { log: tenantAuditLog.log, logException: tenantAuditLog.logException };
  tenantAuditLog.log = () => {};
  tenantAuditLog.logException = () => {};
  try {
    return await run();
  } finally {
    tenantAuditLog.log = originals.log;
    tenantAuditLog.logException = originals.logException;
  }
}

test('GET /DBAPI/ProcessRequest returns the welcome array as JSON', async () => {
  await withServer(app, async (port) => {
    const res = await request(port, { path: '/DBAPI/ProcessRequest' });
    assert.equal(res.status, 200);
    assert.match(res.contentType, /application\/json/);
    assert.equal(res.body, '["Welcome to DB API"]');
  });
});

test('GET /DBAPI/ProcessRequest/:id returns the diagnostic summary with all labels in order', async () => {
  await withServer(app, async (port) => {
    const res = await request(port, { path: '/DBAPI/ProcessRequest/1' });
    assert.equal(res.status, 200);
    assert.match(res.contentType, /application\/json/);

    // Body is a JSON string literal in webapi mode; decode before inspecting.
    const summary = JSON.parse(res.body);
    const labels = [
      'Welcome to LCOM Web API.',
      'Source Website: ',
      'Project Name: ',
      'Target DB Connection String: ',
      'Company Num: ',
      'Whitelisted IPs: ',
      'Blacklisted IPs: ',
      'Enable Logging: ',
      'API Username: ',
      'API Password: ',
      'User IP Address: ',
      'Client Website: ',
      'Is IP Whitelisted: ',
      'Is IP Blacklisted: '
    ];
    let cursor = -1;
    for (const label of labels) {
      const next = summary.indexOf(label, cursor + 1);
      assert.ok(next > cursor, `label out of order or missing: ${label}`);
      cursor = next;
    }
    assert.ok(summary.includes('<br /><br /> <hr />'), 'the <hr /> separator is part of the layout');
    // .NET boolean rendering, not JS 'true'/'false'.
    assert.ok(/Enable Logging: (True|False)/.test(summary));

    // QUIRK, pinned deliberately: the IP gate calls isIPWhitelisted(ip, true), but the
    // summary renders isIPWhitelisted(ip) with checkStarCondition defaulted to false.
    // With whitelistedIPs='*' that branch returns `false && ...`, so a caller who was
    // just admitted is reported as "Is IP Whitelisted: False". Display-only mismatch.
    assert.ok(
      /Is IP Whitelisted: False/.test(summary),
      'the star branch reports False in the summary even though the gate admitted the caller'
    );
    assert.ok(/Is IP Blacklisted: False/.test(summary));
  });
});

test('the diagnostic summary still discloses the decrypted connection string (G3)', async () => {
  // Preserved on purpose. This test exists so that "fixing" it is a deliberate,
  // visible decision (S-1) rather than an accident.
  await withServer(app, async (port) => {
    const res = await request(port, { path: '/DBAPI/ProcessRequest/1' });
    const summary = JSON.parse(res.body);
    const value = summary.split('Target DB Connection String: ')[1].split('<br />')[0];
    assert.ok(value.length > 0, 'connection string must still be present');
    assert.ok(/data source/i.test(value), 'and must still be the decrypted plaintext');
  });
});

test('Accept: application/xml wraps responses in the DataContract string envelope', async () => {
  await withServer(app, async (port) => {
    const res = await request(port, {
      path: '/DBAPI/ProcessRequest/1',
      headers: { Accept: 'application/xml' }
    });
    assert.equal(res.status, 200);
    assert.match(res.contentType, /application\/xml/);
    assert.ok(res.body.startsWith('<string xmlns="http://schemas.microsoft.com/2003/10/Serialization/">'));
    assert.ok(res.body.endsWith('</string>'));
  });
});

test('POST /DBAPI/ProcessRequest returns the stored-procedure output on success', async () => {
  await withSilencedTenantLog(() =>
    withServer(app, async (port) => {
      const original = dbRepository.processDbRequest;
      dbRepository.processDbRequest = async () => ({ output: 'PROC-RESULT' });
      try {
        const res = await request(port, {
          method: 'POST',
          path: '/DBAPI/ProcessRequest',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ActionCode: 'A',
            ViewName: 'V',
            ClientIP: '1.1.1.1',
            JsonReq: {},
            Notes: 'N'
          })
        });
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(res.body), 'PROC-RESULT');
      } finally {
        dbRepository.processDbRequest = original;
      }
    })
  );
});

test('POST accepts the legacy single-quoted body shape (G12)', async () => {
  await withSilencedTenantLog(() =>
    withServer(app, async (port) => {
      const original = dbRepository.processDbRequest;
      dbRepository.processDbRequest = async () => ({ output: 'LEGACY-OK' });
      try {
        const inner = JSON.stringify({
          ActionCode: 'A',
          ViewName: 'V',
          ClientIP: '1.1.1.1',
          JsonReq: {},
          Notes: 'N'
        });
        const res = await request(port, {
          method: 'POST',
          path: '/DBAPI/ProcessRequest',
          headers: { 'Content-Type': 'application/json' },
          body: `'${inner}'`
        });
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(res.body), 'LEGACY-OK');
      } finally {
        dbRepository.processDbRequest = original;
      }
    })
  );
});

test('POST returns HTTP 200 with the exception message when the DB fails (G4)', async () => {
  // Preserved on purpose: caught errors are NOT converted to 4xx/5xx (S-2).
  await withSilencedTenantLog(() =>
    withServer(app, async (port) => {
      const original = dbRepository.processDbRequest;
      dbRepository.processDbRequest = async () => {
        throw new Error('ORA-06550: bad proc');
      };
      try {
        const res = await request(port, {
          method: 'POST',
          path: '/DBAPI/ProcessRequest',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ActionCode: 'A',
            ViewName: 'V',
            ClientIP: '1.1.1.1',
            JsonReq: {},
            Notes: 'N'
          })
        });
        assert.equal(res.status, 200, 'errors after tenant resolution must stay 200');
        assert.equal(JSON.parse(res.body), 'ORA-06550: bad proc');
      } finally {
        dbRepository.processDbRequest = original;
      }
    })
  );
});

test('POST with a malformed body returns 200 carrying the V8 parser message', async () => {
  await withSilencedTenantLog(() =>
    withServer(app, async (port) => {
      const res = await request(port, {
        method: 'POST',
        path: '/DBAPI/ProcessRequest',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json'
      });
      assert.equal(res.status, 200);
      const message = JSON.parse(res.body);
      assert.ok(/JSON/i.test(message), `expected a parser message, got: ${message}`);
    })
  );
});

test('POST with a missing required member returns 200 and the .NET null-reference text', async () => {
  await withSilencedTenantLog(() =>
    withServer(app, async (port) => {
      const res = await request(port, {
        method: 'POST',
        path: '/DBAPI/ProcessRequest',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ActionCode: 'A' })
      });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body), 'Object reference not set to an instance of an object.');
    })
  );
});

test('GET /DBAPI/FlightView proxies the upstream feed verbatim', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '<flights/>' });
  try {
    await withServer(app, async (port) => {
      const res = await request(port, { path: '/DBAPI/FlightView?ACID=AA100' });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body), '<flights/>');
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /DBAPI/FlightView surfaces upstream failures as a 500', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, text: async () => '' });
  try {
    await withServer(app, async (port) => {
      const res = await request(port, { path: '/DBAPI/FlightView' });
      assert.equal(res.status, 500, 'FlightView has no catch — the framework returns a real 500');
      assert.deepEqual(JSON.parse(res.body), { Message: 'An error has occurred.' });
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /DBAPI/FlightView/:id returns the literal stub value', async () => {
  await withServer(app, async (port) => {
    const res = await request(port, { path: '/DBAPI/FlightView/7' });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body), 'value');
  });
});

test('FlightView POST/PUT/DELETE map the C# void actions to 204 No Content', async () => {
  await withServer(app, async (port) => {
    const cases = [
      { method: 'POST', path: '/DBAPI/FlightView' },
      { method: 'PUT', path: '/DBAPI/FlightView/1' },
      { method: 'DELETE', path: '/DBAPI/FlightView/1' }
    ];
    for (const testCase of cases) {
      const res = await request(port, testCase);
      assert.equal(res.status, 204, `${testCase.method} ${testCase.path}`);
      assert.equal(res.body, '');
    }
  });
});

test('unknown routes return the Web API 404 payload', async () => {
  await withServer(app, async (port) => {
    const res = await request(port, { path: '/nope' });
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(res.body), {
      Message: 'No HTTP resource was found that matches the request URI.'
    });
  });
});

test('CORS preflight reproduces the Web.config policy', async () => {
  await withServer(app, async (port) => {
    const res = await request(port, {
      method: 'OPTIONS',
      path: '/DBAPI/ProcessRequest',
      headers: { Origin: 'https://example.test', 'Access-Control-Request-Method': 'POST' }
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(res.headers['access-control-allow-methods'], 'GET,HEAD,OPTIONS,POST,PUT');
    assert.equal(res.headers['access-control-max-age'], '86400');
  });
});
