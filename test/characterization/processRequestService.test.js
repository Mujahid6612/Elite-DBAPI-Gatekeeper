'use strict';

/**
 * CHARACTERIZATION TEST — services/processRequestService.js.
 *
 * The single most important guard in this suite. It pins the exact ORDER of the
 * marker log lines and which of them are gated by enableLogging (guardrail G6),
 * so CQ-18 can decompose handleProcessRequest without changing observable output.
 *
 * A duck-typed config is used, so config.xml is never read and nothing is written
 * into the project's own Log/ tree.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const processRequestService = require('../../services/processRequestService');
const dbRepository = require('../../repositories/dbRepository');
const { Messages } = require('../../constants');
const { LogType } = require('../../constants');
const { makeFakeConfig, readTenantLog } = require('../helpers/fakeTenantConfig');

/** Stubs the DB dispatch and returns the tenant log split into its message bodies. */
async function runRequest(configOverrides, jsonRequest, dbResult = { output: 'DB-OUT' }) {
  const { config, logRoot } = makeFakeConfig({ logType: LogType.Text, ...configOverrides });
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
  }

  return { response, error, dbCalls, log: readTenantLog(logRoot), config };
}

/** Extracts just the message bodies, in order, from a framed tenant log. */
function markers(logText) {
  return [...logText.matchAll(/Recording message at .+?\n([\s\S]*?)\n={85}/g)].map((m) => m[1]);
}

const VALID_BODY = JSON.stringify({
  ActionCode: 'A1',
  ViewName: 'V1',
  ClientIP: '9.9.9.9',
  JsonReq: { q: 1 },
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
    connectionString: 'Data Source=FAKE;user id=U;password=P;',
    dbType: '2',
    procName: 'REQUEST_HANDLER.ACTIONS',
    actionCode: 'A1',
    companyNum: '101',
    viewName: 'V1',
    clientIP: '9.9.9.9',
    jsonReq: '{\r\n  "q": 1\r\n}',
    notes: 'N1'
  });
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
      JsonReq: { JHeader: header, JData: {} },
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
    JsonReq: JSON.stringify({ JHeader: { APILogin: 'u', APIPassword: 'p' } }),
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
    JsonReq: { JHeader: { APILogin: 'u', APIPassword: 'WRONG' } },
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
