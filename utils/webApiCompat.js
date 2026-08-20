'use strict';

const envConfig = require('../config/env');

/**
 * Reproduces ASP.NET's `[FromBody]string` binding for the historical clients.
 * Accepts: legacy single-quoted string, a standard JSON string containing the
 * object text, or direct raw JSON object text.
 */
function unwrapFromBodyString(rawBody) {
  const raw = rawBody === undefined || rawBody === null ? '' : String(rawBody);
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  // JSON.NET accepts both double- and single-quoted JSON string literals. The
  // legacy test pages post '{...}' as a primitive string. Support that shape.
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }

  // Additive compatibility with the migration requirements' direct-raw-JSON
  // assumption. Does not affect legacy string-wrapped clients.
  return raw;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Sends a value the way classic ASP.NET Web API would send a CLR `string`
 * result through content negotiation (JsonFormatter, with text/html and
 * multipart/form-data also mapped to it, per the original WebApiConfig).
 */
function sendWebApiString(req, res, value, status = 200) {
  const text = value === null || value === undefined ? '' : String(value);

  if (envConfig.stringResponseMode === 'raw') {
    return res.status(status).type('text/plain').send(text);
  }

  const accept = String(req.headers.accept || '').toLowerCase();
  if (accept.includes('application/xml') || accept.includes('text/xml')) {
    return res
      .status(status)
      .type('application/xml')
      .send(`<string xmlns="http://schemas.microsoft.com/2003/10/Serialization/">${xmlEscape(text)}</string>`);
  }

  if (accept.includes('text/html')) res.type('text/html');
  else if (accept.includes('multipart/form-data')) res.type('multipart/form-data');
  else res.type('application/json');

  return res.status(status).send(JSON.stringify(text));
}

module.exports = { unwrapFromBodyString, sendWebApiString };
