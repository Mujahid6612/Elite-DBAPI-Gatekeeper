'use strict';

function getClientIp(req) {
  // Source parity: ASP.NET used UserHostAddress / remote endpoint and did not
  // consume X-Forwarded-For. Express's req.ip only changes when trust proxy is enabled.
  if (req.app?.get('trust proxy')) return req.ip || null;
  return req.socket?.remoteAddress || null;
}

function requestHost(req) {
  // HttpContext.Current.Request.Url.Host excludes the port.
  return req.hostname || String(req.headers.host || '').split(':')[0];
}

module.exports = { getClientIp, requestHost };
