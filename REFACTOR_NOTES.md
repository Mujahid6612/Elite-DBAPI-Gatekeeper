# Refactor notes

Scope agreed with the project owner: **restructure into a full layered architecture; keep external and documented behavior 100% identical**, including the quirks catalogued in `MIGRATION_ANALYSIS.md`.

## What changed and why

### 1. Architecture (Controllers / Services / Repositories / Validators / Middleware / Config / Constants / Utils / Types)
Previously everything for a route lived in one file under `routes/` (tenant resolution, IP/credential checks, DB dispatch, logging, and response formatting all inline). That's now split by responsibility:

- **`controllers/`** — HTTP-only. Parse the request, call one service method, format the response. No business rules.
- **`services/`** — orchestration and business rules (tenant checks, credential checks, marker logging, response shaping). No `req`/`res`, no SQL.
- **`repositories/`** — only talks to Oracle/SQL Server. `dbRepository.js` dispatches by `dbType`; `oracleRepository.js` / `sqlServerRepository.js` hold the actual stored-procedure calls.
- **`validators/requestTokenParser.js`** — the `requireToken` / `tokenToObjectString` / `tokenToString` field-extraction logic, now reusable and independently testable.
- **`middleware/`** — CORS policy, 404 handler, and the centralized error handler are now standalone, composable Express middleware instead of inline closures in `app.js`.
- **`constants/`**, **`config/`**, **`types/`** — unchanged responsibilities, just given a dedicated top-level home instead of being mixed into the project root.

**Benefit:** each piece is independently testable (see how `validators/requestTokenParser.js` and `repositories/adoConnectionString.js` are now unit-testable without spinning up Express or a DB), and a future SQL Server tenant or a new controller doesn't require touching route-handling code.

### 2. Bug fix: `npm test` never actually ran the test suite
`package.json`'s `test` script was `echo "Error: no test specified" && exit 1` — a placeholder that always fails, meaning `parity.test.js` (which validates the encryption round-trip against your real production secrets) was never executed by `npm test`, ever. Fixed to `node --test test/*.test.js`. All 5 parity tests pass against the refactored code.

### 3. Bug fix: `db/dbAccess.js` didn't match its own test file
`parity.test.js` imports `parseAdoConnectionString` from the DB module, but that export didn't exist in the supplied `db/dbAccess.js` — so the test suite would have thrown `TypeError: parseAdoConnectionString is not a function` the moment it was actually run. This is now `repositories/adoConnectionString.js`, exported through `repositories/dbRepository.js`, and covered by the existing test.

### 4. Bug fix: hardcoded, unconditional Oracle Thick-client path
The supplied `db/dbAccess.js` called this at module load, unconditionally, for every environment:

```js
oracledb.initOracleClient({ libDir: "C:\\app\\azs\\product\\21c\\dbhomeXE\\bin" });
```

This directly contradicts the project's own `README.md`, which documents Thin mode as the default with Thick mode as an opt-in via `ORACLE_THICK_MODE` / `ORACLE_CLIENT_LIB_DIR`. As written, the app cannot start on any machine other than the original author's Windows workstation. `repositories/oracleRepository.js` now only calls `initOracleClient` when `ORACLE_THICK_MODE=true`, using `ORACLE_CLIENT_LIB_DIR` — i.e., it now does what the README already promised. This is not a behavior change from the documented design; it's a fix to match it.

> Neither of the two items above is one of the "preserved quirks" from `MIGRATION_ANALYSIS.md` — those are all about matching the legacy **.NET** app's behavior. These two are Node-implementation-only defects with no C# equivalent, and fixing them was necessary just to get the test suite and the app itself running.

### 5. Everything else: behavior-preserving cleanup only
- Extracted duplicated IP whitelist/blacklist loop logic in `tenantConfig.js` into `Array.prototype.some()` — identical return values, less code.
- Named/organized what used to be anonymous inline logic (`buildDiagnosticSummary`, `extractRequestFields`, `buildUpstreamQuery`) — no logic changes.
- Removed a dead no-op line in `processRequest.js` (`void (driverType === DriverType.Microsoft ? ... : ...)`) that computed a value and discarded it.
- Added JSDoc typedefs (`types/index.js`) for the request payload and stored-procedure argument/result shapes, since this is a plain CommonJS project without a TypeScript build step.
- Every intentionally-preserved quirk from `MIGRATION_ANALYSIS.md` — the secret-leaking diagnostic GET, the null-config logging bug in the POST catch block, the wildcard `*` tenant shadowing `SELF`, exceptions returned as HTTP 200, marker logs firing regardless of `enableLogging`, no error email — is reproduced exactly, including *how* it's structured in code (e.g. `config` is still declared outside the `try` block in `processRequestController.js` specifically so it survives into the `catch` block the same way it did in the original).
- `parity.test.js` assertions are byte-for-byte identical to the supplied version — only import paths changed.

## Explicitly NOT changed (flagging for your decision, not fixing silently)
Per `MIGRATION_ANALYSIS.md` and your instruction to keep behavior identical:
- Diagnostic GET still returns the decrypted connection string + API password.
- POST catch block still has the null-config logging bug.
- Wildcard `*` tenant still shadows the explicit `SELF` block.
- Caught POST exceptions still return as HTTP 200 with the exception message as body.
- No error email is sent on the POST error path.
- `.env`'s `SERVER_PORT` variable is still a no-op (the app only reads `PORT`) — I left this as-is rather than silently changing which variable controls the port.
- Oracle pool credentials still come from a single static `.env` (`ORACLE_USER`/`ORACLE_PASSWORD`/`ORACLE_CONNECTION`), not from each tenant's decrypted `targetDBConnectionString` in `config.xml`. This means every tenant currently shares one DB identity regardless of `config.xml`. This looked worth a second look, but changing it would be a real behavior change to a currently-working path, so I left it and am flagging it here instead.

## Security reminder
The uploaded archive's `.env` contains what look like live Oracle credentials, and `config.xml` contains a real encrypted connection string. Neither is reproduced in this delivery. Rotate the Oracle password shown in your original `.env` if this project has ever left your control, and keep `.env` out of version control going forward (it already is, per `.gitignore`).
