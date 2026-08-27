'use strict';

/** Renders .NET's `Boolean.ToString()`, which is 'True'/'False', not 'true'/'false'. */
function dotNetBool(value) {
  return value ? 'True' : 'False';
}

/** Written in place of a secret value that is configured but must not be disclosed. */
const REDACTED = '***REDACTED***';

/**
 * Reports whether a secret is set without revealing it: an unset value still renders
 * as an empty field, so an operator can still tell "not configured" from "configured",
 * which is the only diagnostic signal these two lines ever legitimately carried.
 */
function maskSecret(value) {
  return String(value ?? '') === '' ? '' : REDACTED;
}

/**
 * Renders the diagnostic response body for `GET /DBAPI/ProcessRequest/:id`.
 *
 * SECURITY, CHANGED FROM SOURCE PARITY (was S-1/G3): the .NET original printed the
 * tenant's DECRYPTED connection string and API password here in clear text, to any
 * caller that cleared the IP gate. Both supplied tenants set `whitelistedIPs=*`, so
 * on the public deployment that gate admits everyone and this endpoint handed out
 * live database credentials to anonymous callers. The two secret-bearing values are
 * now masked by `maskSecret`.
 *
 * Everything else is untouched: label text, order, the `<br /><br />` framing and the
 * lone space inside '<br /><br /> <hr />' are all still byte-for-byte as before, so
 * the response layout and any parser reading it keep working. `targetDBConnectionString`
 * is still READ rather than skipped, so a tenant whose ciphertext no longer decrypts
 * still fails here exactly as it used to instead of silently reporting healthy.
 *
 * Presentation markup lives here rather than in the service so that services/ stays
 * free of HTML.
 */
function renderDiagnosticSummary(config, clientIP, host) {
  return [
    'Welcome to LCOM Web API.',
    `<br /><br />Source Website: ${config.sourceWebsite}`,
    `<br /><br />Project Name: ${config.projectName}`,
    `<br /><br />Target DB Connection String: ${maskSecret(config.targetDBConnectionString)}`,
    `<br /><br />Company Num: ${config.companyNum}`,
    `<br /><br />Whitelisted IPs: ${config.whitelistedIPs}`,
    `<br /><br />Blacklisted IPs: ${config.blacklistedIPs}`,
    `<br /><br />Enable Logging: ${dotNetBool(config.enableLogging)}`,
    `<br /><br />API Username: ${config.apiUserName}`,
    `<br /><br />API Password: ${maskSecret(config.apiPassword)}`,
    '<br /><br /> <hr />',
    `<br /><br />User IP Address: ${clientIP}`,
    `<br /><br />Client Website: ${host}`,
    // NOTE: rendered WITHOUT checkStarCondition, unlike the gate in
    // getDiagnosticSummary which passes true. With a '*' whitelist this therefore
    // reports False for a caller that was just admitted. Display-only, preserved.
    `<br /><br />Is IP Whitelisted: ${dotNetBool(config.isIPWhitelisted(clientIP))}`,
    `<br /><br />Is IP Blacklisted: ${dotNetBool(config.isIPBlacklisted(clientIP))}`
  ].join('');
}

module.exports = { renderDiagnosticSummary, dotNetBool, maskSecret, REDACTED };
