'use strict';

/**
 * Describes the nine parameters the stored procedure takes.
 *
 * WHY IT EXISTS: Both database drivers need the same list. Written twice, the two copies would
 *                eventually disagree and quietly corrupt data.
 *
 * ROLE IN THE FLOW: Shared by the Oracle and SQL Server drivers so neither can drift out of step.
 */

/**
 * The stored-procedure call contract, carried over verbatim from the .NET source.
 *
 * This is ONE business contract that used to be written twice, in two dialects -
 * once for Oracle binds and once for SQL Server request inputs. Parameter names,
 * order, direction and the size limits are identical in both, and they can silently
 * drift apart: a maxSize corrected in one driver and missed in the other is a data
 * truncation bug no test would catch.
 *
 * Only the shape lives here. Each repository maps it to its own driver types, since
 * `oracledb.DB_TYPE_CLOB` and `sql.NVarChar(sql.MAX)` have nothing in common.
 *
 * Order is contractual: the Oracle path interpolates these names positionally into
 * an anonymous PL/SQL block.
 */

/** @typedef {'in'|'out'} ParamDirection */
/** @typedef {'string'|'lob'|'number'} ParamKind */

/**
 * @typedef {object} StoredProcParam
 * @property {string} name      bind/parameter name as the procedure declares it
 * @property {string} [arg]     key on the StoredProcArgs object (input params only)
 * @property {ParamDirection} direction
 * @property {ParamKind} kind
 * @property {number} [maxSize] declared width, where the driver needs one
 */

/** @type {readonly StoredProcParam[]} */
const STORED_PROC_PARAMS = Object.freeze(
  [
    { name: 'pActionCode', arg: 'actionCode', direction: 'in', kind: 'string', maxSize: 100 },
    { name: 'pCompanyNum', arg: 'companyNum', direction: 'in', kind: 'string', maxSize: 3 },
    { name: 'pViewName', arg: 'viewName', direction: 'in', kind: 'string', maxSize: 100 },
    { name: 'pClientIP', arg: 'clientIP', direction: 'in', kind: 'string', maxSize: 50 },
    { name: 'pJsonReq', arg: 'jsonReq', direction: 'in', kind: 'lob' },
    { name: 'pNotes', arg: 'notes', direction: 'in', kind: 'lob' },
    { name: 'oCode', direction: 'out', kind: 'number' },
    { name: 'oMessage', direction: 'out', kind: 'string', maxSize: 4000 },
    { name: 'oJsonResp', direction: 'out', kind: 'lob' }
  ].map(Object.freeze)
);

/** The output parameter carrying the response payload. */
const RESPONSE_PARAM = 'oJsonResp';

const INPUT_PARAMS = Object.freeze(STORED_PROC_PARAMS.filter((p) => p.direction === 'in'));
const OUTPUT_PARAMS = Object.freeze(STORED_PROC_PARAMS.filter((p) => p.direction === 'out'));

module.exports = { STORED_PROC_PARAMS, INPUT_PARAMS, OUTPUT_PARAMS, RESPONSE_PARAM };
