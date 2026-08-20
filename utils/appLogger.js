'use strict';

const envConfig = require('../config/env');

/**
 * Application logger: process lifecycle events and unhandled request errors.
 *
 * This is NOT the per-tenant audit log. `utils/tenantAuditLog.js` writes the
 * .NET-parity audit files under `Log/<company>/<year>/`, and every byte of that
 * output is contractual. Nothing here may be used for tenant audit records.
 *
 * Deliberately dependency-free: a thin console wrapper that adds a timestamp, a
 * level and structured metadata. Errors and warnings go to stderr, everything
 * else to stdout, so container runtimes classify them correctly.
 */

const LEVELS = Object.freeze({ silent: 0, error: 1, warn: 2, info: 3, debug: 4 });
const DEFAULT_LEVEL = 'info';

function thresholdValue() {
  const configured = LEVELS[envConfig.logLevel];
  return configured === undefined ? LEVELS[DEFAULT_LEVEL] : configured;
}

function isEnabled(level) {
  return LEVELS[level] <= thresholdValue();
}

/** JSON.stringify that survives circular references and unwraps Error values. */
function serializeMeta(meta) {
  const seen = new WeakSet();
  return JSON.stringify(meta, (key, value) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  });
}

function formatLine(level, message, meta) {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  if (meta === undefined || meta === null) return line;

  const keys = Object.keys(meta);
  if (keys.length === 0) return line;

  try {
    return `${line} ${serializeMeta(meta)}`;
  } catch {
    // Never let a logging failure escape into the caller's control flow.
    return `${line} [unserializable metadata]`;
  }
}

function emit(level, message, meta) {
  if (!isEnabled(level)) return;

  const line = formatLine(level, message, meta);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

module.exports = {
  LEVELS,
  error: (message, meta) => emit('error', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  info: (message, meta) => emit('info', message, meta),
  debug: (message, meta) => emit('debug', message, meta)
};
