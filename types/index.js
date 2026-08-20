'use strict';

/**
 * @typedef {object} ProcessRequestPayload
 * @property {string} ActionCode
 * @property {string} ViewName
 * @property {string} ClientIP
 * @property {string|object} JsonReq
 * @property {string} Notes
 * @property {string} [APILogin]
 * @property {string} [APIPassword]
 */

/**
 * @typedef {object} StoredProcArgs
 * @property {string} actionCode
 * @property {string} companyNum
 * @property {string} viewName
 * @property {string} clientIP
 * @property {string} jsonReq
 * @property {string} notes
 */

/**
 * @typedef {object} StoredProcResult
 * @property {string} output
 * @property {string} oCode
 * @property {string} oMessage
 */

// This module intentionally has no runtime exports; it exists so other files can
// reference these typedefs via `@param {import('../types').ProcessRequestPayload}`.
//
// Referenced by: repositories/dbRepository.js, repositories/oracleRepository.js,
// repositories/sqlServerRepository.js and services/processRequestService.js. These
// are the single source of truth - do not re-declare any of them locally.
module.exports = {};
