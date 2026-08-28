# Request flow — from a client tap to an Oracle session

How a request travels from either client app, through the Gatekeeper, to a database —
and exactly where each decision is made. Every code block below is the real code, not
pseudocode.

- [The one-paragraph version](#the-one-paragraph-version)
- [The configuration file](#the-configuration-file)
- [Step 0 — the clients](#step-0--the-clients)
- [Steps 1–11 — inside the Gatekeeper](#step-1--http-arrives)
- [A worked example](#a-worked-example-end-to-end)
- [Where to change what](#where-to-change-what)
- [Failure modes](#failure-modes-and-what-the-caller-sees)

---

## The one-paragraph version

A client POSTs a JSON envelope to `/DBAPI/ProcessRequest`. The Gatekeeper reads
**`Source` and `Target` from `JsonReq.JHeader`** and looks them up in
[`config/tenants.jsonc`](config/tenants.jsonc). The matching block decides everything:
which database to connect to, which stored procedure to call, which company number to
pass, and where to write the audit log. It then executes that procedure — normally
`REQUEST_HANDLER.ACTIONS` — with a fixed 9-parameter contract, and returns its output as
the response body. All business logic lives in the database; the Gatekeeper is a
controlled front door.

---

## The configuration file

Everything is in one file. There is **no XML** and no Host-header matching — both were
removed. A block is selected by what the calling application says it is.

**Comments are permitted** in `config/tenants.jsonc`, as in `tsconfig.json`, so the shipped
file annotates its own values — see [`utils/jsonWithComments.js`](utils/jsonWithComments.js).
The example below omits them for brevity.

```jsonc
{
  "default": {                     // used BEFORE the body is parsed — see Step 4
    "projectName": "WebAPI Itself",
    "companyNum": "999",
    "whitelistedIPs": "*",
    "enableLogging": true,
    "logType": 1,                  // 1 = .txt
    "logPath": "~/Log"
  },

  "databases": [
    {
      "projectName": "Elite Production Database",
      "sources": ["EliteNativeApp", "EliteIdWebApp"],
      "target": "DBAPI",
      "companyNum": "101",
      "whitelistedIPs": "*",
      "blacklistedIPs": "",
      "enableLogging": true,
      "apiUserName": "",           // credential check runs only if BOTH are set
      "apiPassword": "",
      "connectionString": "",      // empty -> falls back to ORACLE_* env vars
      "dbType": 2,                 // 2 = Oracle
      "driverType": 0,             // unread; kept from the .NET enum
      "procName": "REQUEST_HANDLER.ACTIONS",
      "logType": 0,                // 0 = .html
      "logPath": "~/Log"
    }
  ]
}
```

This is the shipped file verbatim. Every field is listed in
[README.md](README.md#every-field); anything **not** listed there is rejected at startup,
so a typo like `"procname"` fails loudly instead of silently running with a default. An
optional `description` field is accepted for a short per-block note but is never read —
the explanation lives in the README rather than inside the JSON.

`projectName` **is the block's identifier.** There is no separate `name` field — one
identifier cannot drift out of step with another. It is required, and it is what you see
in validation errors (`databases["Elite Production Database"]: unknown field …`), startup
log lines and `/DBAPI/Health-Info` entries. Name the DATABASE, not an app: several sources
share a block.

**Many-to-one is the point.** A block lists every source that shares it, so all three
apps above reach the same database with the same `companyNum`, `procName` and audit
settings. One-to-one is a block with a single source. The same source may also appear on
several blocks with different targets (`AppA/DBAPI` and `AppA/REPORTING`).

Matching is **case-insensitive** and whitespace-trimmed. An unconfigured pair is
**refused** — never served from a default, because that would send one application's
traffic to another's database.

### Three ways a block gets its credentials

| In the block | Credentials come from |
| --- | --- |
| `"connectionString": "<ciphertext>"` | the decrypted ADO string, split into user / password / Data Source |
| `"envPrefix": "DB_ELITE_ID"` | `DB_ELITE_ID_USER` / `_PASSWORD` / `_CONNECT_STRING` |
| neither | `ORACLE_USER` / `ORACLE_PASSWORD` / `ORACLE_CONNECTION` |

Declaring both `connectionString` and `envPrefix` is rejected at startup.

> **The passphrase lives in the environment**, as `CONFIG_ENCRYPTION_KEY` — never in the
> repository. That is what makes committing ciphertext safe. The previous scheme kept its
> passphrase in `configReader.js` beside the ciphertext it protected, so anyone with a
> clone could decrypt every connection string. Generate a value with
> `npm run encrypt-secret -- "Data Source=…;user id=…;password=…;"`.

---

## Step 0 — the clients

Both apps send the same envelope shape. They differ in how they get there.

### EliteApp (React Native) — talks to the Gatekeeper directly

`src/Services/apiService.ts`:

```ts
const SOURCE = Config.SOURCE || 'EliteNativeApp';
const TARGET = Config.TARGET || 'DBAPI';

const buildPayload = async (actionCode, viewName, jData) => ({
  ActionCode: actionCode,
  ViewName: viewName,
  ClientIP: await getClientIP(),
  JsonReq: {
    JHeader: {
      Client: Config.CLIENT,      // "ELITE" — the COMPANY, same in both apps
      Source: SOURCE,             // ─┐ these two select the block
      Target: TARGET,             // ─┘
      ViewName: viewName,
      ActionCode: actionCode,
      APILogin: Config.API_LOGIN,
      APIPassword: Config.API_PASSWORD,
      // … device + GPS fields
    },
    JMetaData: {},
    JData: sanitizeJData(jData),
  },
  Notes: 'Test Notes ...',
});

await axiosInstance.post(GATEWAY_PATH, payload);   // GATEWAY_PATH = /DBAPI/ProcessRequest
```

Note `Client` is `"ELITE"` in **both** applications — it names the company, not the app,
so it cannot distinguish them. `Source` is what does.

The `|| 'EliteNativeApp'` fallback is load-bearing. `Config.SOURCE` is `undefined`
whenever react-native-config fails to resolve an env file, and `JSON.stringify` **drops
undefined keys** — the JHeader would ship with no `Source` at all and every request would
be refused.

### EliteIDApp (browser) — talks through a server-side proxy

The browser **never** contacts the Gatekeeper. It posts a slim body to a same-origin
serverless function, which assembles the real envelope:

```js
// api/process-request.js — runs on the server
const config = {
  url: process.env.DBAPI_URL.trim(),
  login: process.env.DBAPI_LOGIN,
  password: process.env.DBAPI_PASSWORD,
  actionCode: process.env.DBAPI_ACTION_CODE.trim(),
  source: (process.env.DBAPI_SOURCE || 'EliteIdWebApp').trim(),
  target: (process.env.DBAPI_TARGET || 'DBAPI').trim()
};
```

Why: the credentials used to be literals in the bundle, readable with View Source. Moving
them to `VITE_*` would not have helped — Vite inlines those too. A server hop is the only
fix. As a side effect the browser can no longer choose which application it claims to be,
which matters now that `Source` selects a database.

```
Browser ──POST /api/process-request──▶ proxy ──POST /DBAPI/ProcessRequest──▶ Gatekeeper
  sends: viewName, clientIP,            adds: APILogin/APIPassword,
         device{}, gps{}, jData{}             ActionCode, Source/Target, upstream URL
```

---

## Step 1 — HTTP arrives

`app.js`. Note the body is kept as **text**, not parsed as JSON:

```js
app.use(express.text({ type: '*/*', limit: envConfig.bodyLimit }));
```

`type: '*/*'` is required and must not be narrowed. The original ASP.NET signature was
`[FromBody]string`, and historical clients post the object text wrapped in single quotes
under assorted content types. Narrowing the matcher leaves `req.body` undefined for them.

## Step 2 — unwrap the `[FromBody]string` shape

`middleware/fromBodyString.js` → `utils/webApiCompat.js`. Three historical shapes are
accepted:

```js
function unwrapFromBodyString(rawBody) {
  const trimmed = String(rawBody ?? '').trim();
  if (!trimmed) return raw;

  // 1. a JSON string literal containing the object text  →  "{\"ActionCode\":…}"
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed); } catch { return raw; }
  }
  // 2. the legacy single-quoted form  →  '{ … }'
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
  // 3. direct raw JSON object text
  return raw;
}
```

Shape 1 is what EliteIDApp sends (its proxy does `JSON.stringify(JSON.stringify(env))`).
Shape 3 is what EliteApp sends. Both work unchanged.

## Step 3 — take the default block

`controllers/processRequestController.js`:

```js
// The DEFAULT block: it supplies the pre-parse audit line and the IP gate.
// Source/Target inside the body select the database, later in the service.
config = tenantRegistry.defaultTenant();
```

There is no Host lookup any more. See Step 4 for why a default is needed at all.

## Steps 4–11 — the ordered pipeline

This is `handleProcessRequest` in `services/processRequestService.js`, verbatim. The step
order is **contractual** — it is observable through the tenant audit file, and the numeric
markers must interleave with the work exactly as shown:

```js
async function handleProcessRequest(config, jsonRequest, observedClientIP) {
  const audit = tenantAuditLog.createTenantLogger(config);

  logInboundRequest(audit, config, jsonRequest);        // ── 4. REQUEST block

  assertIpAllowed(config, observedClientIP);            // ── 5. IP gate
  audit.log(`-1:${audit.lineBreak}`);

  const jObject = JSON.parse(jsonRequest);              // ── 6. parse
  audit.log(`0:${audit.lineBreak}`);

  const fields = extractRequestFields(jObject, config); // ── 7. required members
  assertApiCredentials(jObject, config);                // ── 8. credentials

  const block = resolveRequestConnection(jObject);      // ── 9. WHICH BLOCK

  logExtractedFields(audit, config, jsonRequest, fields);

  const dbResult = await dbRepository.processDbRequest({ // ── 10. execute
    connection: tenantRegistry.connectionFor(block),
    connectionString: block.targetDBConnectionString,
    dbType: block.dbType,
    procName: block.procName,
    ...fields,
    companyNum: block.companyNum
  });

  const response = toResponseText(dbResult.output);      // ── 11. \n → space
  logOutboundResponse(audit, config, response);
  return response;
}
```

The audit log makes the sequence visible:
`REQUEST → -1: → 0: → jsonRequest/ActionCode → 1: → RESPONSE → 2:`

### 4–5. Why the `default` block exists

Look at the order: the audit logger is built and the `REQUEST` line written **before**
`JSON.parse`. The IP gate runs there too. `Source` and `Target` are inside the body, so
they do not exist yet — something must supply `logType`, `logPath` and the IP policy for
those two steps. That is the `default` block's entire job.

It is also the tenant for every route that carries no envelope at all: FlightView, the
diagnostic GET, the access log, and 404s.

```js
function assertIpAllowed(config, observedClientIP) {
  if (!config.isIPWhitelisted(observedClientIP, true)) {
    throw new Error(`${Messages.BLACKLISTED_MESSAGE} [IP:${observedClientIP}]`);
  }
}
```

Every block sets `whitelistedIPs: "*"`, so **this currently admits everyone**.

### 7. Required members

Five fields must be present or the request fails with the .NET null-reference text:

```js
function extractRequestFields(jObject, config) {
  return {
    actionCode: tokenToObjectString(requireToken(jObject, 'ActionCode')),
    companyNum: config.companyNum,        // overwritten by the block at step 10
    viewName:   tokenToObjectString(requireToken(jObject, 'ViewName')),
    clientIP:   tokenToObjectString(requireToken(jObject, 'ClientIP')),
    jsonReq:    tokenToString(requireToken(jObject, 'JsonReq')),
    notes:      tokenToObjectString(requireToken(jObject, 'Notes'))
  };
}
```

`companyNum` never comes from the request body — a caller cannot spoof it.

### 9. Which block — the routing step

```js
function resolveRequestConnection(jObject) {
  const header = requestHeader(jObject) || {};
  const source = fixNullString(tokenToObjectString(header.Source));
  const target = fixNullString(tokenToObjectString(header.Target));

  if (source === '' || target === '') {
    throw new Error(Messages.MISSING_ROUTE_FIELDS);
  }

  const block = tenantRegistry.resolveTenant(source, target);
  if (!block) {
    appLogger.warn('Rejected request with an unconfigured Source/Target pair', {
      source, target, configured: tenantRegistry.describeRoutes()
    });
    throw new Error(`${Messages.UNKNOWN_ROUTE} [Source:${source}, Target:${target}]`);
  }

  return block;
}
```

Three deliberate choices:

1. **It runs AFTER the credential check.** Otherwise an unauthenticated caller could
   enumerate which Source/Target pairs a deployment serves by comparing responses.
2. **No fallback.** An unknown pair is refused rather than served from some default.
3. **The configured routes are logged, not returned.** The caller sees only the values
   _it_ sent; enumerating the other applications to an anonymous caller would be a leak.

The lookup itself upper-cases both sides, which is what makes matching case-insensitive:

```js
function routeKey(source, target) {
  return `${String(source).trim().toUpperCase()} ${String(target).trim().toUpperCase()}`;
}
```

### 10a. Resolve the credentials

`config/tenantRegistry.js` turns the block into a connection descriptor:

```js
function connectionFor(tenant) {
  const cipherText = String(tenant._block.connectionString || '').trim();

  if (cipherText !== '') {
    const ado = parseAdoConnectionString(tenant.targetDBConnectionString);  // decrypts
    return {
      name: tenant.name,
      poolKey: `cs:${cipherText}`,          // credential identity, not the block name
      user: ado['user id'] || ado.uid || '',
      password: ado.password || ado.pwd || '',
      connectString: ado['data source'] || ado.server || '',
      poolMax: tenant.poolMax
    };
  }

  const prefix = tenant.envPrefix;
  const secrets = envConfig.readConnectionSecrets(prefix);
  return { name: tenant.name, poolKey: prefix ? `env:${prefix}` : '', ...secrets, poolMax: tenant.poolMax };
}
```

An ADO string like `Data Source=ELDevWan;user id=SCOTT;password=TIGER;` becomes
`connectString: 'ELDevWan'`, `user: 'SCOTT'`, `password: 'TIGER'`.

### 10b. Get the pool

`repositories/oracleRepository.js`. Pools are keyed by **credential identity**, not by
block name:

```js
async function poolFor(connection) {
  const key = poolKey(connection);
  if (key === '') return ensurePool();       // '' = the default ORACLE_* pool

  const existing = namedPools.get(key);
  if (existing) return existing;

  initializeOracleClient();

  const pending = oracledb.createPool(buildPoolOptions(connection)).catch((error) => {
    namedPools.delete(key);                  // a failed connect is NOT cached
    throw error;
  });

  namedPools.set(key, pending);
  return pending;
}
```

Three sources sharing a block hold **one** Oracle pool between them, not three. Entries
are promises, so concurrent first-callers share a single in-flight connect.

> **Serverless session math.** `poolMax` is per _process_, and each function instance is
> its own process. Total sessions are **instances × distinct databases × poolMax**, and
> nothing here caps the first factor. Set `"poolMax": 1` or `2` on a block.

### 10c. Execute the stored procedure

The SQL is generated from a shared 9-parameter contract
(`repositories/storedProcContract.js`):

```sql
BEGIN
  REQUEST_HANDLER.ACTIONS(
    :pActionCode, :pCompanyNum, :pViewName, :pClientIP, :pJsonReq, :pNotes,
    :oCode, :oMessage, :oJsonResp
  );
END;
```

| Bind | Direction | Type | Max | From |
| --- | --- | --- | --- | --- |
| `pActionCode` | in | STRING | 100 | body `ActionCode` |
| `pCompanyNum` | in | STRING | 3 | **the matched block** |
| `pViewName` | in | STRING | 100 | body `ViewName` |
| `pClientIP` | in | STRING | 50 | body `ClientIP` |
| `pJsonReq` | in | CLOB | — | body `JsonReq` (the whole JHeader/JData) |
| `pNotes` | in | CLOB | — | body `Notes` |
| `oCode` | out | NUMBER | — | _ignored externally_ |
| `oMessage` | out | STRING | 4000 | _ignored externally_ |
| `oJsonResp` | out | CLOB | — | **becomes the response body** |

Request data is always **bound**, never interpolated — only `procName` goes into the SQL
text, and it comes from the block, not the request.

`Source`, `Target` and `RequestedURL` all travel to the database inside `pJsonReq`.
Routing _reads_ them; it does not consume them.

### 11. Shape the response

```js
function toResponseText(dbOutput) {
  return fixNullString(dbOutput).replace(/\n/g, ' ');
}
```

C#'s `Replace('\n', ' ')` removes LF only, leaving any preceding CR intact — reproduced
exactly. The result goes through `sendWebApiString`, which reproduces classic ASP.NET Web
API content negotiation (JSON by default; XML for `Accept: application/xml`).

---

## A worked example, end to end

EliteApp requests the home screen.

```
1.  POST https://elite-dbapi-gatekeeper.vercel.app/DBAPI/ProcessRequest

    {"ActionCode":"S.APP.HOME","ViewName":"HOME","ClientIP":"203.0.113.5",
     "JsonReq":{"JHeader":{"Source":"EliteNativeApp","Target":"DBAPI", …},
                "JData":{"p_VP_COMPANY_NUM":"101"}},
     "Notes":"Test Notes ..."}

2.  express.text          → req.body is the raw text
3.  fromBodyString        → shape 3 (raw JSON), passed through unchanged

4.  DEFAULT BLOCK         → logType 1, logPath ~/Log, company 999
    REQUEST line written to Log/999/<year>/<date>.txt

5.  IP gate  whitelistedIPs='*'  → admitted        │ marker -1:
6.  JSON.parse                                     │ marker 0:
7.  extract   ActionCode / ViewName / ClientIP / JsonReq / Notes
8.  creds     block apiUserName is blank → check skipped

9.  ROUTING   Source 'EliteNativeApp' + Target 'DBAPI'
              → routeKey 'ELITENATIVEAPP DBAPI'
              → block 'Elite Production Database'
                  companyNum 101, procName REQUEST_HANDLER.ACTIONS, dbType 2,
                  logType 0 → Log/101/<year>/<date>.html

10. connectionFor(block)  → connectionString empty, no envPrefix
                          → ORACLE_USER / ORACLE_PASSWORD / ORACLE_CONNECTION
                          → poolKey '' → the default pool

    execute   BEGIN REQUEST_HANDLER.ACTIONS(:pActionCode, :pCompanyNum, …); END;
              pCompanyNum = '101'   ← from the block, not the body

11. oJsonResp → LF replaced with spaces → HTTP 200, JSON-encoded string
```

Note the audit trail spans **two files**: the pre-parse `REQUEST` line goes to the default
block's log (`999`, `.txt`), and everything from `0:` onward to the matched block's
(`101`, `.html`). That split is a direct consequence of the ordering in Step 4.

---

## Where to change what

| To change… | Edit | Restart needed? |
| --- | --- | --- |
| Which database a Source/Target reaches | `config/tenants.jsonc` | Yes |
| Company number / stored procedure / log type for an app | its block in `config/tenants.jsonc` | Yes |
| Pre-parse logging or the pre-parse IP gate | the `default` block | Yes |
| A database's credentials | the block's `connectionString`, or its `envPrefix` variables | Yes |
| Add a new client application | add its name to a block's `sources` | Yes |

### Letting another app share an existing database

```jsonc
"sources": ["EliteNativeApp", "EliteIdWebApp", "EliteWebsite"]
```

That is the whole change. All three get the same `companyNum`, `procName`, audit settings
and **the same Oracle pool**.

### Giving an app its own database

```jsonc
{
  "projectName": "Elite Reporting Database",
  "sources": ["EliteBackOffice"],
  "target": "REPORTING",
  "companyNum": "102",
  "procName": "REPORT_PKG.RUN",
  "dbType": 2,
  "logType": 1,
  "logPath": "~/Log",
  "whitelistedIPs": "*",
  "poolMax": 2,
  "connectionString": "<from npm run encrypt-secret>"
}
```

### Renaming a source

Routing is strict, so a rename is a two-sided change. Add the new name **alongside** the
old one in `sources` first; then ship the clients in any order and remove the old name
once no traffic uses it. The Gatekeeper logs the `Source` of every refused request and an
`ACCESS:` entry for every accepted one, so that is checkable rather than a guess.

---

## Failure modes and what the caller sees

Every message below is returned with **HTTP 200** — the always-200 contract is preserved
from the .NET original, and clients depend on it.

| Condition | Response body |
| --- | --- |
| IP not whitelisted | `Access Denied. …your IP is blacklisted. [IP:x.x.x.x]` |
| Body missing a required member | `Object reference not set to an instance of an object.` |
| Bad credentials (when a block sets both) | `Access Denied. …incorrect login/password.` |
| **No Source/Target in JHeader** | `Access Denied. This request is missing the JsonReq.JHeader values Source and Target…` |
| **Unconfigured Source/Target** | `Access Denied. …do not match any database configured for this deployment. [Source:X, Target:Y]` |
| Malformed JSON body | the V8 parser message, e.g. `Unexpected token …` |
| Oracle / driver / filesystem fault | `An error has occurred.` — detail is logged, not returned |

Two wording rules apply to anything returned to a caller, and both are load-bearing:

1. **Start with `Access Denied.`** — `utils/clientSafeError.js` allowlists that prefix, so
   the message survives verbatim instead of being replaced by the generic string.
2. **Avoid the words _error_, _failed_, _exception_** — the EliteID web client rewrites any
   message containing them into _"Job acknowledged. You may close this browser window
   now."_, which would tell a driver their job was complete when it was not.

### Startup failures

`validateEnv` refuses to start, listing every problem at once, on: a missing `default`
block; a block with no `sources` or no `target`; a source claimed by two blocks; an
unknown field (a typo would otherwise run with a default nobody chose); both
`connectionString` and `envPrefix` on one block; a non-positive `poolMax`; a referenced
environment variable that is unset; or ciphertext with no `CONFIG_ENCRYPTION_KEY`.

---

## Health check

`GET /DBAPI/Health-Info` probes **every distinct database**, deduplicated by pool
identity, and creates a pool for one that no request has used yet:

```jsonc
{
  "application": { "status": "UP", "startedAt": "…", "pid": 1, "uptime": {} },
  "database": { "status": "DOWN", "connected": false, "error": "ORA-12541: …" },
  "databases": [
    { "name": "Elite Production Database", "envPrefix": null, "status": "UP" },
    { "name": "Elite Reporting Database", "envPrefix": "env:DB_ELITE_ID", "status": "DOWN" }
  ]
}
```

The aggregate `database` is UP only when every database is — a partial outage means some
source's traffic is failing and must not read as healthy.
