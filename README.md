# LcomAPI / DBAPI — Node.js parity migration

This project is a Node.js/Express migration of the supplied ASP.NET Web API 2 `LcomAPI` backend. It preserves the public `/DBAPI/...` route shapes, tenant resolution, IP checks, stored-procedure parameter contract, log file layout, and legacy encrypted connection-string compatibility.

**Read `MIGRATION_ANALYSIS.md` before production deployment.** It documents source/spec discrepancies and behavior that is intentionally preserved even though it looks like a bug (e.g. a diagnostic endpoint that leaks the decrypted connection string). Do not "fix" those without a deliberate, signed-off decision — see that file for the full list.

## Architecture

```
DBAPI-NODEJS/
├── app.js                     # Express app assembly: middleware pipeline + routes
├── server.js                  # Process entrypoint: DB pool, then HTTP listen
├── config/
│   ├── env.js                 # All process.env reads, in one place
│   └── tenantConfig.js        # ConfigReader: parses config.xml per tenant, per request
├── constants/
│   └── index.js                # Enums & fixed message strings
├── controllers/                # Thin HTTP layer: parse request, call a service, send response
│   ├── processRequestController.js
│   └── flightViewController.js
├── services/                   # Business logic, orchestration, no HTTP or SQL details
│   ├── processRequestService.js
│   └── flightViewService.js
├── repositories/                # Data access only
│   ├── oracleRepository.js
│   ├── sqlServerRepository.js
│   ├── dbRepository.js         # Dispatches by tenant dbType
│   └── adoConnectionString.js
├── validators/
│   └── requestTokenParser.js   # Required-field extraction / JToken-string semantics
├── middleware/
│   ├── corsPolicy.js
│   ├── notFoundHandler.js
│   └── errorHandler.js
├── utils/                       # Cross-cutting helpers (logging, encryption, null-coalescing)
├── types/                       # Shared JSDoc typedefs (plain JS project, no build step)
└── test/
    └── parity.test.js
```

**Request flow:** `routes/` → `controllers/` (HTTP-only concerns: parse request, call service, format response) → `services/` (tenant resolution, IP/credential checks, orchestration) → `repositories/` (Oracle/SQL Server stored-procedure execution). `config/tenantConfig.js` and `utils/` are shared across all layers.

## Requirements

- Node.js 20+
- Network access to the configured database
- For the supplied Oracle tenant: a usable Oracle connection environment. The encrypted connection string uses a `Data Source` alias, so provide a `tnsnames.ora` directory through `TNS_ADMIN` or `ORACLE_CONFIG_DIR` if the alias is not otherwise resolvable.

`node-oracledb` uses Thin mode by default. Set `ORACLE_THICK_MODE=true` and `ORACLE_CLIENT_LIB_DIR=<path>` only when your Oracle environment requires Thick mode — nothing is hardcoded to a specific machine's client install path.

## Run

```bash
cp .env.example .env   # then fill in your own Oracle credentials
npm install
npm test
npm start
```

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

`config.xml` is intentionally retained in its original XML format and is re-read from disk on every `ConfigReader` construction, matching the C# implementation. The DB connection string remains encrypted with the project's legacy AES/Rijndael scheme.

## Database

Current supplied tenant configuration is `dbType=2` (Oracle), via `node-oracledb`. A SQL Server path (`dbType=1`) is included via `mssql` (loaded lazily). `dbType=0` (OLE DB) is rejected explicitly — no portable Node driver exists for it.

## Security note

`config.xml` and `.env` contain real credentials/secrets for this deployment. Rotate them if this repository or its history has ever been shared outside your team, and never commit a populated `.env`.
# Elite-DBAPI-Gatekeeper
