'use strict';

/**
 * Tells GatewayConnector that new outbound messages were just added.
 *
 * WHY IT EXISTS: GatewayConnector sends the emails, SMS and push notifications that the apps
 *                queue in the database. Without a signal it can only find new rows by reading
 *                the queue on a timer; with one, it reads at once (within about a second).
 *
 * ROLE IN THE FLOW: Called by services/processRequestService.js after the stored procedure
 *                   returned, for every request. It acts only when the matched database block
 *                   lists the request's action code under "gatewayConnector.actions", the
 *                   procedure reported success, and GC_WAKE_QUEUE_URL is set. It then puts
 *                   `{"source":"elite","channel":"email"}` on that SQS queue.
 *
 * WHAT IT MUST NEVER DO: change the response, fail the request, or write to the tenant audit
 * log (whose content is contractual). Every failure is swallowed and reported to the
 * application log only; a lost signal just means GatewayConnector picks the rows up on its
 * next safety-net read. The send is bounded by GC_WAKE_TIMEOUT_MS.
 */

const envConfig = require('../config/env');
const appLogger = require('../utils/appLogger');

let defaultSender = null;

/** Lazily builds the SQS sender, so the SDK is only loaded where the feature is switched on. */
function sqsSender() {
  if (!defaultSender) {
    const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
    const settings = envConfig.gatewayConnectorWake;
    const client = new SQSClient({
      region: settings.region,
      credentials: settings.accessKeyId
        ? { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey }
        : undefined
    });
    defaultSender = (queueUrl, body, signal) =>
      client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }), { abortSignal: signal });
  }
  return defaultSender;
}

/**
 * True when the procedure output reports success: JHeader.ActionCode (or ResponseCode) 0.
 * The output is JSON text, possibly encoded twice (a JSON string holding the JSON).
 */
function procedureSucceeded(output) {
  try {
    let value = JSON.parse(String(output));
    if (typeof value === 'string') value = JSON.parse(value);
    const header = value && typeof value === 'object' ? value.JHeader || value.jHeader : null;
    if (!header || typeof header !== 'object') return false;
    const code = header.ActionCode ?? header.ResponseCode;
    return code !== undefined && code !== null && code !== '' && Number(code) === 0;
  } catch {
    return false;
  }
}

/**
 * The signal this request should send, or null.
 * @param {import('../config/tenant')} block the matched database block
 * @param {string} actionCode the request's ActionCode
 * @param {string} output the stored procedure's output
 */
function signalFor(block, actionCode, output) {
  const settings = block && block.gatewayConnector;
  if (!settings) return null;
  const channel = settings.actions.get(
    String(actionCode || '')
      .trim()
      .toUpperCase()
  );
  if (channel === undefined) return null;
  if (!procedureSucceeded(output)) return null;
  return channel ? { source: settings.source, channel } : { source: settings.source };
}

/**
 * Sends the wake signal when this request warrants one. Never throws and never takes longer
 * than the configured timeout. Resolves to true when a signal was accepted by SQS.
 *
 * `options.send` and `options.queueUrl` exist for tests; production uses the environment.
 */
async function notifyAfterAction(block, actionCode, output, options = {}) {
  try {
    const queueUrl = options.queueUrl ?? envConfig.gatewayConnectorWake.queueUrl;
    if (!queueUrl) return false;
    const signal = signalFor(block, actionCode, output);
    if (!signal) return false;
    const send = options.send || sqsSender();
    const timeoutMs = options.timeoutMs ?? envConfig.gatewayConnectorWake.timeoutMs;
    // An explicit race, so the bound holds even if the SDK ignored the abort.
    const abort = new AbortController();
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error(`no answer from SQS within ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      await Promise.race([send(queueUrl, JSON.stringify(signal), abort.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return true;
  } catch (error) {
    appLogger.warn('GatewayConnector wake signal not sent; it will pick the rows up on its next read', {
      actionCode,
      message: error && error.message
    });
    return false;
  }
}

module.exports = { notifyAfterAction, signalFor, procedureSucceeded };
