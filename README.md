# Elite DB Gatekeeper

Elite DB Gatekeeper (`elite-db-gatekeeper`) is a Node.js/Express migration of the ASP.NET Web API 2 `LcomAPI` / `DBAPI` backend. It is referred to as **Elite DB Gatekeeper** throughout; `LcomAPI` and `DBAPI` appear only where they name the original .NET application or the `/DBAPI/...` route prefix, which is unchanged. It preserves the public `/DBAPI/...` route shapes, tenant resolution, IP checks, stored-procedure parameter contract, log file layout, and legacy encrypted connection-string compatibility.

**Read `MIGRATION_ANALYSIS.md` before production deployment.** It documents source/spec discrepancies and behavior that is intentionally preserved even though it looks like a bug (e.g. a diagnostic endpoint that leaks the decrypted connection string). Do not "fix" those without a deliberate, signed-off decision — see that file for the full list.

## Architecture

```
EliteDBGateKeeper/
├── app.js                       # Express app assembly: middleware pipeline + routes
├── server.js                    # Process entrypoint: validate env, DB pool, listen, graceful shutdown
├── config/
│   ├── tenants.jsonc            # THE configuration: default block + one block per database
│   ├── tenantRegistry.js        # Loads/validates tenants.jsonc; resolves Source+Target
│   ├── tenant.js                # One block, with typed accessors and the IP gate
│   ├── env.js                   # All process.env reads, in one place
│   ├── validateEnv.js           # Fail-fast startup validation of environment + tenants.jsonc
│   └── ipAccessPolicy.js        # Whitelist/blacklist matching, incl. the '*' recursion
├── constants/
│   └── index.js                 # Enums & fixed message strings
├── controllers/                 # Thin HTTP layer: parse request, call a service, send response
│   ├── processRequestController.js
│   └── flightViewController.js
├── services/                    # Business logic, orchestration, no HTTP or SQL details
│   ├── processRequestService.js
│   ├── diagnosticSummaryView.js # Renders the diagnostic body (contains secret-bearing lines)
│   └── flightViewService.js
├── repositories/                # Data access only
│   ├── dbRepository.js          # Dispatches by tenant dbType
│   ├── oracleRepository.js
│   ├── sqlServerRepository.js
│   ├── storedProcContract.js    # The 9-parameter contract, shared by both drivers
│   └── adoConnectionString.js
├── parsers/
│   └── requestTokenParser.js    # JToken-string semantics + required-field checks
├── middleware/
│   ├── corsPolicy.js
│   ├── fromBodyString.js        # Reproduces ASP.NET [FromBody]string binding
│   ├── notFoundHandler.js
│   └── errorHandler.js
├── utils/                       # Cross-cutting helpers
│   ├── appLogger.js             # Application log: lifecycle + unhandled errors (format may change)
│   ├── tenantAuditLog.js        # Per-tenant .NET-parity audit files (output is contractual)
│   ├── encryption.js            # Legacy PasswordDeriveBytes + AES-CBC
│   ├── webApiCompat.js          # Web API string content negotiation
│   ├── xmlText.js               # escapeXml / unescapeXml (exact inverses)
│   ├── requestUtils.js
│   └── nullHelpers.js
├── types/                       # Shared JSDoc typedefs (plain JS project, no build step)
└── test/
    ├── parity.test.js           # .NET parity suite (encryption, tenant matching, body binding)
    ├── helpers/                 # Shared doubles: fake tenant config, fake req/res, HTTP client
    ├── characterization/        # Pins pre-existing behavior; a refactor must not edit these
    └── unit/                    # Covers newly written code; free to evolve
```

Tooling: `eslint.config.js` (flat config), `.prettierrc.json`, `.editorconfig`, `.nvmrc`,
and `.github/workflows/ci.yml` (lint + format check + tests on Node 20).

**Request flow:** `routes/` → `controllers/` (HTTP-only concerns: parse request, call service, format response) → `services/` (tenant resolution, IP/credential checks, orchestration) → `repositories/` (Oracle/SQL Server stored-procedure execution). `config/` and `utils/` are shared across all layers.

## Requirements

- Node.js 20+ (enforced via `engines`; `.nvmrc` pins 20)
- Network access to the configured database
- For the supplied Oracle tenant: a usable Oracle connection environment. The encrypted connection string uses a `Data Source` alias, so provide a `tnsnames.ora` directory through `TNS_ADMIN` or `ORACLE_CONFIG_DIR` if the alias is not otherwise resolvable.

`node-oracledb` uses Thin mode by default. Set `ORACLE_THICK_MODE=true` and `ORACLE_CLIENT_LIB_DIR=<path>` only when your Oracle environment requires Thick mode — nothing is hardcoded to a specific machine's client install path.

> **Upgrading an existing Windows deployment.** Earlier builds called
> `initOracleClient()` unconditionally at module load with a hardcoded path, so they
> always ran in **Thick** mode regardless of `ORACLE_THICK_MODE`. That call is now
> gated by the flag. To keep the previous behavior on that host, set
> `ORACLE_THICK_MODE=true` and `ORACLE_CLIENT_LIB_DIR` to the Oracle client `bin`
> directory. Left unset, the service now starts in Thin mode.

## Run

```bash
cp .env.example .env   # then fill in ORACLE_USER / ORACLE_PASSWORD / ORACLE_CONNECTION
npm ci
npm run lint
npm test
npm start
```

Available scripts: `npm test` (parity + characterization suites), `npm run lint`,
`npm run lint:fix`, `npm run format`, `npm run format:check`, `npm run dev` (nodemon),
`npm start`.

Default listen address: `http://0.0.0.0:5000` (or `PORT` from `.env`).

## Core POST request

```text
POST /DBAPI/ProcessRequest
Content-Type: application/json
```

The original ASP.NET signature is `[FromBody]string jsonRequest`. This migration accepts all three historical forms for compatibility:

1. legacy single-quoted string: `'{ ... }'`,
2. standard JSON string containing the object text,
3. direct raw JSON object text.

Expected inner object fields: `ActionCode`, `ViewName`, `ClientIP`, `JsonReq`, `Notes`, plus `APILogin` / `APIPassword` when the selected tenant enables body credentials.

## Response mode

`STRING_RESPONSE_MODE=webapi` (default) serializes CLR-`string`-style action results the way classic ASP.NET Web API content negotiation would. `STRING_RESPONSE_MODE=raw` is an explicit opt-in for clients built against a raw-string assumption.

## Configuration

Every `process.env` read lives in `config/env.js`, which freezes a typed config object at load. No other module
reads the environment (`repositories/oracleRepository.js` still *writes* `process.env.TNS_ADMIN`, because the
Oracle client also reads it out-of-band). This is enforced by the `n/no-process-env` ESLint rule, and a test
asserts that `.env.example` documents exactly the set of variables the code actually reads — no more, no less.

`BODY_LIMIT` (default `2mb`) caps the accepted request body and is the service's primary denial-of-service
control. Note that an over-limit request currently surfaces as a **500**, not a 413, because the error handler
returns the generic Web API payload for every unhandled error.

All configuration lives in [`config/tenants.jsonc`](config/tenants.jsonc). The XML layer
(`config.xml`, `ConfigReader`, and its parser) has been removed: blocks are now selected
by the `Source`/`Target` the client sends rather than by the request Host.

## Database routing

Everything is configured in [`config/tenants.jsonc`](config/tenants.jsonc). **Comments are
permitted in that file** — hence the `.jsonc` extension, which is what stops an editor
flagging every one as a syntax error — so it explains its own values in place, including why several fields are deliberately left empty. The parser
([`utils/jsonWithComments.js`](utils/jsonWithComments.js)) is string-aware rather than a
regex, because `connectionString` holds base64 and a value can legitimately contain `//`.

A request is routed by the `Source` and `Target` values inside `JsonReq.JHeader`:

```
(Source, Target)  ->  a database block  ->  credentials  ->  Oracle
```

```jsonc
{
  "default": {                       // used BEFORE the body is parsed — see below
    "projectName": "WebAPI Itself",
    "companyNum": "999",
    "whitelistedIPs": "*",
    "enableLogging": true,
    "logType": 1,
    "logPath": "~/Log"
  },

  "databases": [
    {
      "projectName": "Elite Production Database",
      "sources": ["NativeApp", "WebApp"],
      "target": "DBAPI",
      "companyNum": "101",
      "whitelistedIPs": "*",
      "blacklistedIPs": "",
      "enableLogging": true,
      "apiUserName": "",
      "apiPassword": "",
      "connectionString": "",
      "dbType": 2,
      "driverType": 0,
      "procName": "REQUEST_HANDLER.ACTIONS",
      "logType": 0,
      "logPath": "~/Log"
    }
  ]
}
```

### Many-to-one is the point

A block lists **every source that shares it**. All three apps above reach the same
database with the same `companyNum`, `procName` and audit settings. One-to-one is just
a block with a single source. The same source may also appear on several blocks with
different targets (`AppA/DBAPI` and `AppA/REPORTING`).

Matching is **case-insensitive**, and an unconfigured pair is **refused** — never
served from a default, because that would send one app's traffic to another's database.

### Why there is a `default` block

The audit log and the IP gate run **before the body is parsed** — the `REQUEST` line and
the `-1:` marker come first, and that order is contractual. `Source` and `Target` do not
exist yet at that point, so the `default` block supplies `logType`, `logPath` and the IP
policy for those two steps. The matched block takes over for everything after the parse.
It is also the tenant for routes that carry no envelope: FlightView, the diagnostic GET,
the access log and 404s.

### Every field

| Field | Required | What it does |
| --- | --- | --- |
| `projectName` | **yes** | The block's identifier. Appears in validation errors, startup log lines and health entries |
| `sources` | **yes** | Array of application names this block serves. Listing several is many-to-one |
| `target` | **yes** | The logical database role. `(source, target)` is the lookup key |
| `companyNum` | | Bound to the `pCompanyNum` stored-procedure parameter. Never taken from the request body |
| `procName` | | The stored procedure to call, e.g. `REQUEST_HANDLER.ACTIONS` |
| `dbType` | | `2` Oracle, `1` SQL Server (needs `npm install mssql`), `0` OLE DB — rejected explicitly |
| `whitelistedIPs` / `blacklistedIPs` | | Comma-separated exact matches, or `*`. No CIDR |
| `enableLogging` | | Gates the REQUEST/RESPONSE audit blocks. The numeric markers fire regardless |
| `apiUserName` / `apiPassword` | | Body credential check. **Skipped entirely unless BOTH are set** |
| `connectionString` | | Encrypted ADO string — see below |
| `envPrefix` | | Alternative to `connectionString` — see below |
| `poolMax` | | Oracle session ceiling for this database. Positive whole number |
| `logType` | | `0` → `.html`, `1` → `.txt`, `2` → console |
| `logPath` | | Base directory. `~/Log` resolves against `LOG_ROOT` |
| `driverType` | | **Unread.** Carried over from the .NET enum; kept so the value is not lost |
| `description` | | **Unread.** A leftover escape hatch from before comments were supported. Prefer a `//` comment |

Any other field is **rejected at startup**. A typo like `"procname"` would otherwise be
silently ignored and the block would run with a default nobody chose.

### Three ways a block gets its credentials

| In the block | Credentials come from | Use when |
|---|---|---|
| `"connectionString": "<ciphertext>"` | decrypted ADO string, split into user / password / Data Source | the connection details belong with the config |
| `"envPrefix": "DB_ELITE_ID"` | `DB_ELITE_ID_USER` / `_PASSWORD` / `_CONNECT_STRING` | the platform's secret store is the source of truth |
| neither | `ORACLE_USER` / `ORACLE_PASSWORD` / `ORACLE_CONNECTION` | the single pre-existing database |

Setting both `connectionString` and `envPrefix` is rejected at startup.

**Pool identity is the credentials, not the block name.** Blocks resolving to the same
database share one Oracle pool, so `instances × blocks × poolMax` does not multiply for
no reason. `"poolMax": 2` on a block caps that database specifically.

### Encrypting a connection string

```bash
npm run encrypt-secret -- "Data Source=ELDevWan;user id=APIUSER;password=secret;"
```

The passphrase comes from **`CONFIG_ENCRYPTION_KEY` in the environment**, never from the
repository. That is what makes committing the ciphertext safe — the legacy scheme kept
its passphrase in `configReader.js` beside the ciphertext, so anyone with a clone could
decrypt it. Startup fails by name if a block carries ciphertext and no key is set.

The tool verifies the value round-trips before printing it, and accepts `-` to read the
plaintext from stdin so it stays out of your shell history.

### Validation happens at startup, not at first request

`validateEnv` refuses to start on: a missing `default` block, a block with no sources or
target, a source claimed by two blocks, an unknown field (a typo would otherwise run with
a default nobody chose), both credential styles at once, a non-positive `poolMax`, a
referenced environment variable that is unset, or ciphertext with no `CONFIG_ENCRYPTION_KEY`.
Every problem is reported in one message rather than one per restart.

## Database

Current supplied tenant configuration is `dbType=2` (Oracle), via `node-oracledb`. A SQL Server path (`dbType=1`) is included via `mssql`, declared as an **optional peer dependency** and loaded lazily: it is not installed by default, because no configured tenant uses it and its transitive dependency tree is large. Activating a `dbType=1` tenant requires `npm install mssql` first; without it the path fails with an explicit message rather than a bare module-not-found error. `dbType=0` (OLE DB) is rejected explicitly — no portable Node driver exists for it.

## Logging

Two separate, deliberately distinct loggers:

- **`utils/tenantAuditLog.js`** — the per-tenant audit trail inherited from the .NET app. Writes
  `Log/<companyNum>/<year>/<dd-MMM-yyyy>.html|txt`. Every function needs a tenant `config`, and the file layout,
  framing and line-break characters are part of the parity contract. **Do not change its output.**
- **`utils/appLogger.js`** — ordinary application logging: startup, shutdown and unhandled request errors. Takes no
  tenant, writes timestamped, levelled lines to stdout/stderr, and its format is free to evolve. Controlled by
  `LOG_LEVEL` (`silent`/`error`/`warn`/`info`/`debug`, default `info`); `LOG_LEVEL` does not affect the audit log.

Unhandled request errors are logged with their message, stack, method and path. The HTTP response body is unchanged
by this — it remains the generic `{"Message":"An error has occurred."}` payload unless `EXPOSE_ERRORS=true`.

## Shutdown

`SIGTERM` / `SIGINT` trigger a graceful shutdown: the server stops accepting connections,
in-flight requests are allowed to finish, idle keep-alive sockets are reaped as they fall
idle, database pools are closed, then the process exits. `SHUTDOWN_TIMEOUT_MS`
(default 15000) is a hard cap, so a hung drain cannot wedge a deployment. `unhandledRejection`
and `uncaughtException` are logged before the process exits.

## Performance notes

The tenant audit log is written synchronously. Measured on the development machine, a
request with `enableLogging=1` performs 8 `appendFileSync` calls (~0.023ms each) and those
writes account for roughly **82%** of its total cost; `enableLogging=0` halves the writes and
roughly doubles throughput. Because the writes are synchronous they stall the event loop for
all concurrent requests, not just the one being logged. Making them asynchronous would change
log line ordering under concurrency, which is observable in the audit file, so it is
deliberately NOT done - raise it as an explicit decision if throughput becomes a constraint.

Separately, `node-oracledb`'s default `poolMax` is 4, so at most four database operations run
concurrently regardless of host capacity. Raise `ORACLE_POOL_MAX` if that becomes the limit.

## Startup validation

`config/validateEnv.js` runs before any connection is attempted and fails fast with a single aggregated message
listing every problem, rather than one per restart. It checks `PORT`, `STRING_RESPONSE_MODE`, `EVENT_LOG_FALLBACK`,
`LOG_LEVEL`, and the presence of `ORACLE_USER` / `ORACLE_PASSWORD` / `ORACLE_CONNECTION`. It also warns at startup
when `EXPOSE_ERRORS` is enabled. Every default in `config/env.js` is preserved, so a correctly configured
deployment behaves exactly as before.

## Security note

`.env` contains real credentials for this deployment and must never be committed. `config/tenants.jsonc` IS committed and is safe to be, because it holds only ciphertext and variable names — the passphrase lives in `CONFIG_ENCRYPTION_KEY`. The **legacy** `config.xml` ciphertext was decryptable with key material hardcoded in the repository, so anything encrypted under the old passphrase must be treated as compromised and rotated.
# Elite-DBAPI-Gatekeeper
