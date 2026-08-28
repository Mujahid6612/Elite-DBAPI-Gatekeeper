'use strict';

/**
 * Unwraps the request body into the text the rest of the code expects.
 *
 * WHY IT EXISTS: The original .NET API took the whole request object as a *string*, and long-
 *                standing clients still send it that way.
 *
 * ROLE IN THE FLOW: Runs just before the ProcessRequest controller, on that route only.
 */

const { unwrapFromBodyString } = require('../utils/webApiCompat');

/**
 * Reproduces ASP.NET's `[FromBody]string` binding as transport middleware.
 *
 * This is the same kind of concern as `express.text()` in app.js - decoding the wire
 * format - so it belongs in the pipeline rather than inside a controller.
 *
 * Exposes the result as `req.jsonRequest` and deliberately does NOT overwrite
 * `req.body`: utils/tenantAuditLog.js inspects `req.body` when formatting exception
 * reports and only renders a "Form Variables" block when it is an object. Replacing
 * the string body with a parsed value there would change the audit log output.
 *
 * Registered only on the routes that need it, so no other route's handling changes.
 */
function fromBodyString(req, res, next) {
  req.jsonRequest = unwrapFromBodyString(req.body);
  next();
}

module.exports = fromBodyString;
