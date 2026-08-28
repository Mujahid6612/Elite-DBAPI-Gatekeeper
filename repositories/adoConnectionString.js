'use strict';

/**
 * Splits an old-style `Key=Value;Key=Value;` connection string into its parts.
 *
 * WHY IT EXISTS: Connection strings are stored in the Windows/.NET format, but the Oracle driver
 *                needs the username, password and database name separately.
 *
 * ROLE IN THE FLOW: Used when a configuration block supplies its own connection string.
 */

/**
 * Parses a `Key1=Val1;Key2=Val2;` ADO.NET-style connection string into an
 * object keyed by lower-cased, trimmed key names, preserving embedded value
 * text as-is (values are not trimmed, matching ADO.NET's literal handling).
 * @param {string} connectionString
 * @returns {Record<string, string>}
 */
function parseAdoConnectionString(connectionString) {
  const result = {};
  const raw = String(connectionString || '');

  raw.split(';').forEach((pair) => {
    if (!pair.trim()) return;
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) return;

    const key = pair.slice(0, separatorIndex).trim().toLowerCase();
    const value = pair.slice(separatorIndex + 1);
    if (key) result[key] = value;
  });

  return result;
}

module.exports = { parseAdoConnectionString };
