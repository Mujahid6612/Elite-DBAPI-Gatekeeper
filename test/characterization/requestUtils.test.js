'use strict';

/**
 * CHARACTERIZATION TEST — utils/requestUtils.js.
 *
 * Pins the client-IP source (guardrail G15: X-Forwarded-For is ignored unless
 * TRUST_PROXY is on) and the port-stripping host resolution.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { getClientIp, requestHost } = require('../../utils/requestUtils');

const req = ({ trustProxy = false, ip, remoteAddress, hostname, host } = {}) => ({
  app: { get: (key) => (key === 'trust proxy' ? trustProxy : undefined) },
  ip,
  socket: remoteAddress === undefined ? undefined : { remoteAddress },
  hostname,
  headers: host === undefined ? {} : { host }
});

test('with trust proxy OFF the raw socket address is used, ignoring req.ip', () => {
  assert.equal(
    getClientIp(req({ trustProxy: false, ip: '203.0.113.9', remoteAddress: '10.0.0.1' })),
    '10.0.0.1',
    'a forwarded-for derived req.ip must not win'
  );
});

test('with trust proxy ON req.ip is used', () => {
  assert.equal(getClientIp(req({ trustProxy: true, ip: '203.0.113.9', remoteAddress: '10.0.0.1' })), '203.0.113.9');
});

test('getClientIp returns null rather than throwing when the source is missing', () => {
  assert.equal(getClientIp(req({ trustProxy: false })), null);
  assert.equal(getClientIp(req({ trustProxy: true, ip: undefined })), null);
  assert.equal(getClientIp({ socket: { remoteAddress: '10.0.0.2' } }), '10.0.0.2', 'missing req.app is tolerated');
});

test('requestHost prefers req.hostname', () => {
  assert.equal(requestHost(req({ hostname: 'api.example', host: 'other.example:8080' })), 'api.example');
});

test('requestHost falls back to the Host header with the port stripped', () => {
  assert.equal(requestHost(req({ hostname: undefined, host: 'api.example:5000' })), 'api.example');
  assert.equal(requestHost(req({ hostname: undefined, host: 'api.example' })), 'api.example');
  assert.equal(requestHost(req({ hostname: undefined })), '', 'no host header yields an empty string');
});
