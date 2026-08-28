'use strict';

/**
 * CHARACTERIZATION TEST — services/processRequestService.js.
 *
 * The single most important guard in this suite. It pins the exact ORDER of the
 * marker log lines and which of them are gated by enableLogging (guardrail G6),
 * so CQ-18 can decompose handleProcessRequest without changing observable output.
 *
 * A duck-typed config is used, so config/tenants.jsonc is never read and nothing is written
 * into the project's own Log/ tree.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const processRequestService = require('../../services/processRequestService');
const dbRepository = require('../../repositories/dbRepository');
const { Messages } = require('../../constants');
const { LogType } = require('../../constants');
const { makeFakeConfig, readTenantLog } = require('../helpers/fakeTenantConfig');
const tenantRegistry = require('../../config/tenantRegistry');
const Tenant = require('../../config/tenant');

/** Stubs the DB dispatch and returns the tenant log split into its message bodies. */
async function runRequest(configOverrides, jsonRequest, dbResult = { output: 'DB-OUT' }) {
  const { config, logRoot } = makeFakeConfig({ logType: LogType.Text, ...configOverrides });

  // The DEFAULT block (`config`) supplies pre-parse logging and the IP gate; the
  // MATCHED block supplies companyNum, procName, dbType and the database. Both are
  // built from the same overrides so a test can express either in one place.
  const registryOriginals = { resolve: tenantRegistry.resolveTenant, connectionFor: tenantRegistry.connectionFor };
  const matched = new Tenant({
    name: 'elite_main',
    sources: ['NativeApp', 'WebApp'],
    target: 'DBAPI',
    companyNum: '101',
    procName: 'REQUEST_HANDLER.ACTIONS',
    dbType: '2',
    ...configOverrides
  });
  tenantRegistry.resolveTenant = (source, target) =>
    matched.sources.some((s2) => s2.toUpperCase() === String(source).toUpperCase()) &&
    String(target).toUpperCase() === 'DBAPI'
      ? matched
      : null;
  tenantRegistry.connectionFor = () => ({
    name: 'elite_main',
    poolKey: '',
    user: 'u',
    password: 'p',
    connectString: 'C'
  });

  const original = dbRepository.processDbRequest;
  const dbCalls = [];
  dbRepository.processDbRequest = async (request) => {
    dbCalls.push(request);
    if (dbResult instanceof Error) throw dbResult;
    return dbResult;
  };

  let response;
  let error = null;
  try {
    response = await processRequestService.handleProcessRequest(config, jsonRequest, '10.0.0.1');
  } catch (thrown) {
    error = thrown;
  } finally {
    dbRepository.processDbRequest = original;
    tenantRegistry.resolveTenant = registryOriginals.resolve;
    tenantRegistry.connectionFor = registryOriginals.connectionFor;
  }

  return { response, error, dbCalls, log: readTenantLog(logRoot), config };
}

/** Extracts just the message bodies, in order, from a framed tenant log. */
function markers(logText) {
  return [...logText.matchAll(/Recording message at .+?\n([\s\S]*?)\n={85}/g)].map((m) => m[1]);
}

/**
 * A realistic body. `JsonReq.JHeader` carries Source and Target because every real
 * client sends them and the service now routes on them: a body without them is
 * refused, which is covered by its own tests below.
 */
const VALID_BODY = JSON.stringify({
  ActionCode: 'A1',
  ViewName: 'V1',
  ClientIP: '9.9.9.9',
  JsonReq: { JHeader: { Source: 'NativeApp', Target: 'DBAPI' }, q: 1 },
  Notes: 'N1'
});

test('happy path emits markers in exactly this order when enableLogging is ON', async () => {
  const { response, log } = await runRequest({ enableLogging: true }, VALID_BODY);

  assert.equal(response, 'DB-OUT');
  assert.deepEqual(markers(log), [
    `REQUEST:\n${VALID_BODY}`,
    '-1:\n',
    '0:\n',
    `jsonRequest:\n${VALID_BODY}`,
    'ActionCode:\nA1',
    '1:\n',
    'RESPONSE:\nDB-OUT',
    '2:\n'
  ]);
});

test('enableLogging OFF still writes every numeric marker (G6)', async () => {
  const { response, log } = await runRequest({ enableLogging: false }, VALID_BODY);

  assert.equal(response, 'DB-OUT');
  assert.deepEqual(
    markers(log),
    ['-1:\n', '0:\n', '1:\n', '2:\n'],
    'markers must fire regardless of enableLogging; only the labelled blocks are gated'
  );
});

test('the IP gate runs after the REQUEST block but before marker -1:', async () => {
  const { error, log } = await runRequest({ enableLogging: true, isIPWhitelisted: () => false }, VALID_BODY);

  assert.equal(error.message, `${Messages.BLACKLISTED_MESSAGE} [IP:10.0.0.1]`);
  assert.deepEqual(markers(log), [`REQUEST:\n${VALID_BODY}`], 'REQUEST is written, then the gate throws before -1:');
});

test('the IP gate is called with checkStarCondition=true', async () => {
  const seen = [];
  await runRequest(
    {
      isIPWhitelisted: (...args) => {
        seen.push(args);
        return true;
      }
    },
    VALID_BODY
  );
  assert.deepEqual(seen[0], ['10.0.0.1', true]);
});

test('a malformed body throws after marker -1: and before marker 0:', async () => {
  const { error, log } = await runRequest({ enableLogging: false }, '{not json');

  assert.ok(error instanceof SyntaxError, 'V8 parse error propagates as-is (G4 path)');
  assert.deepEqual(markers(log), ['-1:\n'], 'JSON.parse sits between markers -1: and 0:');
});

test('missing required members throw the .NET null-reference error after marker 0:', async () => {
  for (const field of ['ActionCode', 'ViewName', 'ClientIP', 'JsonReq', 'Notes']) {
    const body = JSON.parse(VALID_BODY);
    delete body[field];
    const { error, log } = await runRequest({ enableLogging: false }, JSON.stringify(body));

    assert.equal(error.message, 'Object reference not set to an instance of an object.', `missing ${field}`);
    assert.deepEqual(markers(log), ['-1:\n', '0:\n'], `missing ${field}: extraction runs after marker 0:`);
  }
});

test('companyNum comes from tenant config, never from the request body', async () => {
  const body = JSON.parse(VALID_BODY);
  body.CompanyNum = 'HACK';
  const { dbCalls } = await runRequest({ companyNum: '777' }, JSON.stringify(body));

  assert.equal(dbCalls[0].companyNum, '777');
});

test('JsonReq objects reach the DB as indented JSON with CRLF; other fields as plain text', async () => {
  const { dbCalls } = await runRequest({}, VALID_BODY);

  assert.deepEqual(dbCalls[0], {
    // Resolved from JsonReq.JHeader Source/Target. No envPrefix, so this connection
    // uses the default ORACLE_* credentials and shares the default pool.
    connection: { name: 'elite_main', poolKey: '', user: 'u', password: 'p', connectString: 'C' },
    connectionString: '',
    dbType: '2',
    procName: 'REQUEST_HANDLER.ACTIONS',
    actionCode: 'A1',
    companyNum: '101',
    viewName: 'V1',
    clientIP: '9.9.9.9',
    jsonReq: '{\r\n  "JHeader": {\r\n    "Source": "NativeApp",\r\n    "Target": "DBAPI"\r\n  },\r\n  "q": 1\r\n}',
    notes: 'N1'
  });
});

test('the whole JHeader, Source and Target included, still reaches the stored procedure', async () => {
  // Routing reads these fields but must not consume them: the procedure receives the
  // body exactly as sent, so anything the database does with Source/Target is intact.
  const { dbCalls } = await runRequest({}, VALID_BODY);
  const forwarded = JSON.parse(dbCalls[0].jsonReq.replace(/\r\n/g, '\n'));

  assert.equal(forwarded.JHeader.Source, 'NativeApp');
  assert.equal(forwarded.JHeader.Target, 'DBAPI');
});

test('ClientIP is taken from the body, not from the observed connection address', async () => {
  const { dbCalls } = await runRequest({}, VALID_BODY);
  assert.equal(dbCalls[0].clientIP, '9.9.9.9', 'body value wins');
  // The observed IP ('10.0.0.1') is used only for the whitelist gate.
});

test('credentials are checked only when BOTH tenant username and password are set', async () => {
  const withCreds = { apiUserName: 'u', apiPassword: 'p' };

  const missing = await runRequest(withCreds, VALID_BODY);
  assert.equal(
    missing.error.message,
    'Object reference not set to an instance of an object.',
    'absent APILogin/APIPassword members throw the null-reference error first'
  );

  const wrong = await runRequest(
    withCreds,
    JSON.stringify({ ...JSON.parse(VALID_BODY), APILogin: 'u', APIPassword: 'WRONG' })
  );
  assert.equal(wrong.error.message, Messages.INVALID_CREDENTIALS);

  const right = await runRequest(
    withCreds,
    JSON.stringify({ ...JSON.parse(VALID_BODY), APILogin: 'u', APIPassword: 'p' })
  );
  assert.equal(right.error, null);
  assert.equal(right.response, 'DB-OUT');
});

test('credentials are also accepted inside JsonReq.JHeader, where the app actually puts them', async () => {
  // FIX, not parity: the check used to read the TOP LEVEL only, while the EliteApp
  // client sends these inside JsonReq.JHeader (src/Services/apiService.ts). Enabling
  // tenant credentials would therefore have rejected every real request with the
  // null-reference error. Top-level placement still works and is asserted above.
  const withCreds = { apiUserName: 'u', apiPassword: 'p' };
  const nested = (header) =>
    JSON.stringify({
      ActionCode: 'A1',
      ViewName: 'V1',
      ClientIP: '9.9.9.9',
      JsonReq: { JHeader: { Source: 'NativeApp', Target: 'DBAPI', ...header }, JData: {} },
      Notes: 'N1'
    });

  const right = await runRequest(withCreds, nested({ APILogin: 'u', APIPassword: 'p' }));
  assert.equal(right.error, null, 'matching nested credentials must authenticate');
  assert.equal(right.response, 'DB-OUT');

  const wrong = await runRequest(withCreds, nested({ APILogin: 'u', APIPassword: 'WRONG' }));
  assert.equal(wrong.error.message, Messages.INVALID_CREDENTIALS, 'a wrong nested password is still rejected');
});

test('a JsonReq sent as a JSON string still exposes its JHeader credentials', async () => {
  const withCreds = { apiUserName: 'u', apiPassword: 'p' };
  const body = JSON.stringify({
    ActionCode: 'A1',
    ViewName: 'V1',
    ClientIP: '9.9.9.9',
    JsonReq: JSON.stringify({
      JHeader: { Source: 'NativeApp', Target: 'DBAPI', APILogin: 'u', APIPassword: 'p' }
    }),
    Notes: 'N1'
  });

  const { error, response } = await runRequest(withCreds, body);
  assert.equal(error, null);
  assert.equal(response, 'DB-OUT');
});

test('an unparseable JsonReq still yields the null-reference error, not a parser error', async () => {
  // The credential lookup must not convert a malformed JsonReq into a different
  // failure: absent credentials still report the original .NET message.
  const withCreds = { apiUserName: 'u', apiPassword: 'p' };
  const body = JSON.stringify({
    ActionCode: 'A1',
    ViewName: 'V1',
    ClientIP: '9.9.9.9',
    JsonReq: '{not json',
    Notes: 'N1'
  });

  const { error } = await runRequest(withCreds, body);
  assert.equal(error.message, 'Object reference not set to an instance of an object.');
});

test('top-level credentials still win over a nested pair', async () => {
  const withCreds = { apiUserName: 'u', apiPassword: 'p' };
  const body = JSON.stringify({
    ActionCode: 'A1',
    ViewName: 'V1',
    ClientIP: '9.9.9.9',
    JsonReq: { JHeader: { Source: 'NativeApp', Target: 'DBAPI', APILogin: 'u', APIPassword: 'WRONG' } },
    Notes: 'N1',
    APILogin: 'u',
    APIPassword: 'p'
  });

  const { error, response } = await runRequest(withCreds, body);
  assert.equal(error, null, 'the top-level pair is authoritative');
  assert.equal(response, 'DB-OUT');
});

test('a tenant with only a username configured skips the credential check entirely', async () => {
  const { error, response } = await runRequest({ apiUserName: 'u', apiPassword: '' }, VALID_BODY);
  assert.equal(error, null);
  assert.equal(response, 'DB-OUT');
});

test('field extraction precedes the credential check (blocks a CQ-06 reordering)', async () => {
  // Body carries valid credentials but is missing Notes: the null-reference error
  // must win, proving extraction runs first.
  const body = JSON.parse(VALID_BODY);
  delete body.Notes;
  const { error } = await runRequest(
    { apiUserName: 'u', apiPassword: 'p' },
    JSON.stringify({ ...body, APILogin: 'u', APIPassword: 'WRONG' })
  );
  assert.equal(error.message, 'Object reference not set to an instance of an object.');
});

test('the response replaces LF with a space and leaves CR intact (G8)', async () => {
  const { response } = await runRequest({}, VALID_BODY, { output: 'a\nb\r\nc\rd' });
  assert.equal(response, 'a b\r c\rd');
});

test('a null DB output becomes an empty response and is trimmed', async () => {
  const empty = await runRequest({}, VALID_BODY, { output: null });
  assert.equal(empty.response, '');

  const padded = await runRequest({}, VALID_BODY, { output: '  padded  ' });
  assert.equal(padded.response, 'padded');
});

test('a DB failure throws after marker 0: with markers 1: and 2: never written', async () => {
  const { error, log } = await runRequest({ enableLogging: false }, VALID_BODY, new Error('ORA-06550'));

  assert.equal(error.message, 'ORA-06550');
  assert.deepEqual(markers(log), ['-1:\n', '0:\n']);
});

test('Html tenants frame the same sequence with <br> instead of newlines', async () => {
  const { log } = await runRequest({ logType: LogType.Html, enableLogging: false }, VALID_BODY);
  const htmlMarkers = [...log.matchAll(/Recording message at .+?<br>([\s\S]*?)<br>={85}/g)].map((m) => m[1]);
  assert.deepEqual(htmlMarkers, ['-1:<br>', '0:<br>', '1:<br>', '2:<br>']);
});

/* ─────────────────────────  Source/Target database routing  ───────────────────────── */

test('a body with no Source/Target is refused, and never reaches the database', async () => {
  const body = JSON.parse(VALID_BODY);
  body.JsonReq = { q: 1 };
  const { error, dbCalls } = await runRequest({}, JSON.stringify(body));

  assert.equal(error.message, Messages.MISSING_ROUTE_FIELDS);
  assert.equal(dbCalls.length, 0, 'no database may be contacted when the route is unknown');
});

test('Source without Target, and Target without Source, are both refused', async () => {
  for (const header of [{ Source: 'NativeApp' }, { Target: 'DBAPI' }, { Source: '', Target: 'DBAPI' }]) {
    const body = JSON.parse(VALID_BODY);
    body.JsonReq = { JHeader: header };
    const { error } = await runRequest({}, JSON.stringify(body));
    assert.equal(error.message, Messages.MISSING_ROUTE_FIELDS, JSON.stringify(header));
  }
});

test('an unconfigured pair is refused and the values are echoed back for diagnosis', async () => {
  const body = JSON.parse(VALID_BODY);
  body.JsonReq = { JHeader: { Source: 'TypoApp', Target: 'DBAPI' } };
  const { error, dbCalls } = await runRequest({}, JSON.stringify(body));

  assert.ok(error.message.startsWith(Messages.UNKNOWN_ROUTE));
  assert.match(error.message, /Source:TypoApp/, 'the caller sees what its own app sent');
  assert.match(error.message, /Target:DBAPI/);
  assert.equal(dbCalls.length, 0);
});

test('routing rejections carry no words the EliteID client rewrites into a success notice', () => {
  // That client turns any message containing error/failed/exception into "Job
  // acknowledged. You may close this browser window now." A routing problem reported
  // that way would tell a driver their job was complete.
  for (const message of [Messages.MISSING_ROUTE_FIELDS, Messages.UNKNOWN_ROUTE]) {
    assert.ok(message.startsWith('Access Denied.'), 'must survive utils/clientSafeError.js');
    assert.doesNotMatch(message, /error|failed|exception/i, message);
  }
});

test('both shipped clients route successfully: NativeApp and WebApp', async () => {
  for (const source of ['NativeApp', 'WebApp']) {
    const body = JSON.parse(VALID_BODY);
    body.JsonReq = { JHeader: { Source: source, Target: 'DBAPI' } };
    const { error, dbCalls } = await runRequest({}, JSON.stringify(body));

    assert.equal(error, null, `${source} must route`);
    assert.equal(dbCalls[0].connection.name, 'elite_main');
  }
});

test('matching is case-insensitive, so a casing slip does not take an app down', async () => {
  for (const [source, target] of [
    ['nativeapp', 'dbapi'],
    ['NATIVEAPP', 'DBAPI'],
    ['NativeApp', ' DBAPI ']
  ]) {
    const body = JSON.parse(VALID_BODY);
    body.JsonReq = { JHeader: { Source: source, Target: target } };
    const { error } = await runRequest({}, JSON.stringify(body));
    assert.equal(error, null, `${source}/${target}`);
  }
});

test('the credential check runs BEFORE routing, so routes cannot be probed anonymously', async () => {
  // Otherwise an unauthenticated caller could enumerate which Source/Target pairs a
  // deployment serves by comparing which ones produce a different message.
  const body = JSON.parse(VALID_BODY);
  body.JsonReq = { JHeader: { Source: 'TypoApp', Target: 'DBAPI' } };
  const { error } = await runRequest(
    { apiUserName: 'u', apiPassword: 'p' },
    JSON.stringify({ ...body, APILogin: 'u', APIPassword: 'WRONG' })
  );

  assert.equal(error.message, Messages.INVALID_CREDENTIALS, 'credentials must fail first');
});

/* ────────────────  the matched block owns the database settings  ──────────────── */

test('procName, companyNum and dbType all come from the MATCHED block', async () => {
  // Before this change they came from the Host-resolved tenant, so every source on a
  // deployment necessarily shared them. Now a block can give its sources their own.
  const { dbCalls } = await runRequest({ companyNum: '102', procName: 'OTHER_PKG.ACTIONS', dbType: '2' }, VALID_BODY);

  assert.equal(dbCalls[0].companyNum, '102');
  assert.equal(dbCalls[0].procName, 'OTHER_PKG.ACTIONS');
  assert.equal(dbCalls[0].dbType, '2');
});

test('companyNum still comes from configuration, never from the request body', async () => {
  const body = JSON.parse(VALID_BODY);
  body.CompanyNum = 'HACK';

  const { dbCalls } = await runRequest({ companyNum: '102' }, JSON.stringify(body));
  assert.equal(dbCalls[0].companyNum, '102');
});

test('every source on one block shares its companyNum and procedure (many-to-one)', async () => {
  const results = [];
  for (const source of ['NativeApp', 'WebApp']) {
    const body = JSON.parse(VALID_BODY);
    body.JsonReq = { JHeader: { Source: source, Target: 'DBAPI' } };
    const { dbCalls, error } = await runRequest({ companyNum: '101' }, JSON.stringify(body));

    assert.equal(error, null, `${source} must route`);
    results.push({ company: dbCalls[0].companyNum, proc: dbCalls[0].procName });
  }

  assert.deepEqual(results[0], results[1], 'sources sharing a block share its settings');
});
