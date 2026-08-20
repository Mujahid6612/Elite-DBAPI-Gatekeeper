'use strict';

/** Renders .NET's `Boolean.ToString()`, which is 'True'/'False', not 'true'/'false'. */
function dotNetBool(value) {
  return value ? 'True' : 'False';
}

/**
 * Renders the diagnostic response body for `GET /DBAPI/ProcessRequest/:id`.
 *
 * SECURITY: this output includes the tenant's DECRYPTED connection string and API
 * password, disclosed to any caller that clears the IP gate. Preserved deliberately -
 * see MIGRATION_ANALYSIS.md. Every secret-bearing line is in this one file so that
 * redacting them later is a single, reviewable change.
 *
 * Presentation markup lives here rather than in the service so that services/ stays
 * free of HTML. The exact fragments, including the lone space inside
 * '<br /><br /> <hr />', are part of the response body and are asserted by tests.
 */
function renderDiagnosticSummary(config, clientIP, host) {
  return [
    'Welcome to LCOM Web API.',
    `<br /><br />Source Website: ${config.sourceWebsite}`,
    `<br /><br />Project Name: ${config.projectName}`,
    `<br /><br />Target DB Connection String: ${config.targetDBConnectionString}`,
    `<br /><br />Company Num: ${config.companyNum}`,
    `<br /><br />Whitelisted IPs: ${config.whitelistedIPs}`,
    `<br /><br />Blacklisted IPs: ${config.blacklistedIPs}`,
    `<br /><br />Enable Logging: ${dotNetBool(config.enableLogging)}`,
    `<br /><br />API Username: ${config.apiUserName}`,
    `<br /><br />API Password: ${config.apiPassword}`,
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

module.exports = { renderDiagnosticSummary, dotNetBool };
