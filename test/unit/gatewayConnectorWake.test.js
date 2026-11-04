'use strict';

/**
 * UNIT TEST — services/gatewayConnectorWake.js and the "gatewayConnector" block field.
 *
 * The wake signal is an optional side effect bolted onto the main request path, so the
 * properties that matter are the negative ones: it fires ONLY for a listed action whose
 * procedure succeeded, and nothing it does - a missing setting, a slow or failing SQS -
 * can throw into the request, take longer than its timeout, or change what is returned.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Tenant = require('../../config/tenant');
const tenantRegistry = require('../../config/tenantRegistry');
const { notifyAfterAction, signalFor, procedureSucceeded } = require('../../services/gatewayConnectorWake');

const OK = JSON.stringify({ JHeader: { ActionCode: 0, Message: 'Success' }, JData: { id: 7 } });
const FAILED = JSON.stringify({ JHeader: { ActionCode: 3, Message: 'Invalid input' }, JData: null });

const block = new Tenant({
  projectName: 'Elite',
  sources: ['NativeApp'],
  target: 'DBAPI',
  gatewayConnector: { source: 'elite', actions: { 'CMN.I.OUTBOUND_MESSAGE': 'email', 'CMN.I.OUTBOUND_BATCH': '' } }
});
const QUEUE = 'https://sqs.eu-west-1.amazonaws.com/123456789012/gc-wake';

test('the procedure output counts as success only when JHeader reports code 0', () => {
  assert.equal(procedureSucceeded(OK), true);
  assert.equal(procedureSucceeded(JSON.stringify(OK)), true); // double-encoded
  assert.equal(procedureSucceeded(FAILED), false);
  assert.equal(procedureSucceeded('ORA-06550: line 1'), false);
  assert.equal(procedureSucceeded(JSON.stringify({ JData: {} })), false);
});

test('a MySQL (request_handler) output counts by jHeader.responseCode', () => {
  assert.equal(
    procedureSucceeded(JSON.stringify({ jHeader: { responseCode: 0, message: 'OK', status: 'success' }, jData: {} })),
    true
  );
  assert.equal(procedureSucceeded(JSON.stringify({ jHeader: { responseCode: '0' } })), true);
  assert.equal(procedureSucceeded(JSON.stringify(JSON.stringify({ jHeader: { responseCode: 0 } }))), true); // double-encoded
  assert.equal(procedureSucceeded(JSON.stringify({ jHeader: { responseCode: 3, message: 'Invalid' } })), false);
  assert.equal(procedureSucceeded(JSON.stringify({ jHeader: { message: 'no code' } })), false);
});

test('a signal is due only for a listed action code (any case) that succeeded', () => {
  assert.deepEqual(signalFor(block, 'cmn.i.outbound_message', OK), { source: 'elite', channel: 'email' });
  assert.deepEqual(signalFor(block, 'CMN.I.OUTBOUND_BATCH', OK), { source: 'elite' }); // every channel
  assert.equal(signalFor(block, 'CMN.I.OUTBOUND_MESSAGE', FAILED), null);
  assert.equal(signalFor(block, 'CMN.S.SOMETHING_ELSE', OK), null);
  assert.equal(signalFor(new Tenant({ projectName: 'x' }), 'CMN.I.OUTBOUND_MESSAGE', OK), null);
});

test('it sends the JSON signal to the queue when everything lines up', async () => {
  const sent = [];
  const ok = await notifyAfterAction(block, 'CMN.I.OUTBOUND_MESSAGE', OK, {
    queueUrl: QUEUE,
    send: async (url, body) => sent.push({ url, body })
  });
  assert.equal(ok, true);
  assert.deepEqual(sent, [{ url: QUEUE, body: '{"source":"elite","channel":"email"}' }]);
});

test('it does nothing when switched off or not warranted', async () => {
  const send = async () => assert.fail('must not send');
  assert.equal(await notifyAfterAction(block, 'CMN.I.OUTBOUND_MESSAGE', OK, { queueUrl: '', send }), false);
  assert.equal(await notifyAfterAction(block, 'CMN.S.SOMETHING_ELSE', OK, { queueUrl: QUEUE, send }), false);
  assert.equal(await notifyAfterAction(block, 'CMN.I.OUTBOUND_MESSAGE', FAILED, { queueUrl: QUEUE, send }), false);
});

test('a failing or slow SQS never throws and never waits past the timeout', async () => {
  const failing = await notifyAfterAction(block, 'CMN.I.OUTBOUND_MESSAGE', OK, {
    queueUrl: QUEUE,
    send: async () => {
      throw new Error('AccessDenied');
    }
  });
  assert.equal(failing, false);

  const started = Date.now();
  const slow = await notifyAfterAction(block, 'CMN.I.OUTBOUND_MESSAGE', OK, {
    queueUrl: QUEUE,
    timeoutMs: 100,
    // Ignores the abort signal entirely: the bound must still hold.
    send: () => new Promise((resolve) => setTimeout(resolve, 5000).unref())
  });
  assert.equal(slow, false);
  assert.ok(Date.now() - started < 1000);
});

/** Writes a tenant configuration with one database block carrying `gatewayConnector`. */
function registryWith(gatewayConnector) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbgk-wake-'));
  const file = path.join(dir, 'tenants.json');
  const document = {
    default: { projectName: 'Self', companyNum: '999', whitelistedIPs: '*', logType: 1, logPath: '~/Log' },
    databases: [
      {
        projectName: 'Elite',
        sources: ['NativeApp'],
        target: 'DBAPI',
        companyNum: '101',
        procName: 'PKG.ACTIONS',
        dbType: 2,
        gatewayConnector
      }
    ]
  };
  fs.writeFileSync(file, JSON.stringify(document), 'utf8');
  return () => tenantRegistry.readTenantRegistry(file);
}

test('the registry accepts a valid gatewayConnector field and rejects mistakes at load', () => {
  const ok = registryWith({ source: 'elite', actions: { 'CMN.I.OUTBOUND_MESSAGE': 'email' } })();
  assert.equal(ok.blocks[0].gatewayConnector.actions.get('CMN.I.OUTBOUND_MESSAGE'), 'email');

  assert.throws(registryWith({ source: 'Elite!', actions: { X: 'email' } }), /"source" must be/);
  assert.throws(registryWith({ source: 'elite', actions: {} }), /"actions" must map/);
  assert.throws(registryWith({ source: 'elite', actions: { X: 'fax' } }), /channel must be one of/);
  assert.throws(registryWith({ source: 'elite', actions: { X: 'sms' }, queue: 'x' }), /unknown field "queue"/);
});
