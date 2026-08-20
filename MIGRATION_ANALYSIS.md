# DBAPI/LcomAPI migration analysis

> **STATUS: current and authoritative for BEHAVIOR.** Every decision recorded here still
> holds: the preserved quirks below are reproduced by the code and pinned by tests in
> `test/characterization/`. Only file paths have moved - see `README.md` for the current
> layout. Code-quality work is tracked separately in `CODE_QUALITY_RECOMMENDATIONS.md`.

## Scope reviewed

The supplied C# project was inspected controller-by-controller and through each dependency reachable from `FlightViewController` and `ProcessRequestController`: routing, `ConfigReader`, `Configuration`, encryption, logger, `MDBAccess`/`ODBAccess`, and their data handlers. Legacy static UI assets and unrelated shared utility surface were not migrated.

## Confirmed matches between source and migration requirements

| Area | Source result | Node implementation |
|---|---|---|
| Route template | `DBAPI/{controller}/{id}`, optional id | Same `/DBAPI/...` endpoints |
| Core health GET | `['Welcome to DB API']` | Same JSON array |
| Tenant config | `config.xml`, first matching `<appSettings>` | Same XML, first match wins |
| Config reload | XML loaded on every `ConfigReader` construction | Re-read/re-parse every construction |
| IP star behavior | Recursive whitelist/blacklist nuance | Reproduced |
| Main request fields | `ActionCode`, `ViewName`, `ClientIP`, `JsonReq`, `Notes` | Same |
| Optional body credentials | `APILogin`, `APIPassword` | Same |
| Company number | From tenant config, not request | Same |
| Stored procedure | 9 parameters, same names/order and CLOB fields | Same logical bind contract |
| Current DB engine | `dbType=2` Oracle | `node-oracledb` |
| DB output | `oJsonResp` drives response; `oCode`/`oMessage` discarded | Same external behavior |
| Output newline transform | Replaces LF `\n` with a single space | Same |
| Flight query order | `ACID, DEPAP, DEPDATE, DEPHR, ARRAP, ARRDATE, ARRHR, AL, SIMPLESTATUS` | Same |
| Logging path | `<logPath>/<company>/<year>/<dd-MMM-yyyy>.<ext>` | Same |
| Marker logging | `-1:`, `0:`, `1:`, `2:`, `3:` | Preserved |
| Client IP | Server-observed remote address; no XFF logic | Same by default; proxy trust opt-in |

## Material differences found: migration document vs actual C#

### 1. `[FromBody]string` is not simply a raw-body hook

The C# action parameter is formatter-bound. The historical `test3.html` in the project wraps the object text in single quotes before posting `application/json`, which is consistent with feeding a JSON string to `[FromBody]string`. A direct JSON object is not semantically the same binding operation.

**Decision:** the Node route accepts the legacy string-wrapped form and direct raw object text. This is an additive compatibility layer: it preserves existing clients while also supporting the migration requirement's direct-raw assumption.

### 2. Returned C# `string` values are subject to Web API content negotiation

The migration document describes several controller strings as inherently raw `text/plain`/raw XML/HTML. The actual actions simply return CLR `string` values from `ApiController`, so ASP.NET Web API selects a media formatter. `WebApiConfig` also adds `text/html` and `multipart/form-data` as supported media types of `JsonFormatter`.

**Decision:** default `STRING_RESPONSE_MODE=webapi` serializes strings through a Web-API-like response layer. `STRING_RESPONSE_MODE=raw` is an explicit opt-in for integrations built against the migration document's raw-string interpretation.

### 3. `GET /DBAPI/ProcessRequest/{id}` has no catch-all

The source method has no `try/catch`. Config/IP/decryption failures escape to the framework as a real HTTP 500. The migration document's section suggesting this GET always turns exceptions into HTTP 200 does not match the source.

**Decision:** Node leaves these exceptions to the Express 500 handler.

### 4. `POST /DBAPI/ProcessRequest` does not call the email error path

`Logger.LogError(Exception)` contains mail logic, but the controller catch calls `Logger.Log(ex, dummyConfig)` instead. The reachable POST catch therefore does **not** send error email in the supplied source.

**Decision:** no new email is wired into the core route. Adding it would be a behavior change.

### 5. The source's `SELF` fallback is currently shadowed by the wildcard tenant

Current `config.xml` has `<sourceWebsite>*</sourceWebsite>` before `<sourceWebsite>SELF</sourceWebsite>`, and `ConfigReader` stops at the first matching block. Since `*` matches `SELF`, `new ConfigReader("SELF")` selects company `101`, not the later company `999` SELF block.

**Decision:** preserved exactly. Reordering the XML or preferring exact matches would be a functional change. This should be fixed only as a deliberate follow-up.

### 6. FlightView POST/PUT/DELETE are C# `void`

The migration document describes them as HTTP 200 empty stubs. Classic Web API void actions normally map to `204 No Content`.

**Decision:** Node returns 204 for these three stubs.

### 7. FlightView does not forward the upstream content type

The source uses `HttpClient.GetStringAsync()` and returns a C# `string`; it does not retain the upstream response object/content type. The migration document says to return raw XML with the upstream content type, which is not what the code literally does.

**Decision:** returned strings go through the same Node Web-API-style response compatibility layer as other `string` actions.

### 8. Error e-mail/settings listed in the migration document are absent from current Web.config

`Configuration.cs` has many shared-code getters, but the supplied `Web.config` does not define the SMTP/e-mail keys described in the requirements. They are not reachable from the two current controller flows anyway.

**Decision:** no speculative SMTP wiring in the core migration.

## Encryption verification — passed

The source uses `PasswordDeriveBytes` + Rijndael/AES-CBC, MD5, two iterations, 256-bit key, fixed IV. The migration document's simplified KDF prose is not byte-exact to .NET `PasswordDeriveBytes`; the Node implementation instead reproduces the actual .NET derivation behavior.

Verification was performed against **both real encrypted values** from the supplied project (`config.xml` and `Web.config`). The decrypted plaintext is intentionally not written into this report. Verification uses SHA-256 fingerprints of the resulting plaintext plus an encrypt-roundtrip check:

- tenant `config.xml` decrypted plaintext SHA-256: `8f3c3b4582c5ef3ae6cdafc047e5b2007ace21ebfe717f43947abeafccc20045`
- `Web.config` decrypted plaintext SHA-256: `dc13bc3b67256c9ca3923a8261ef694c9436216f5ac1a4231f0cad61a5c3fa32`

The automated test suite verifies both fingerprints and that re-encrypting each plaintext reproduces the original ciphertext byte-for-byte.

## Faithfully preserved but questionable behavior

- Diagnostic GET exposes the decrypted DB connection string and API password to a caller that passes the IP gate.
- Core POST returns an exception message as a normal action string for exceptions caught after tenant creation, instead of using an HTTP error status.
- The catch block has a null-config bug: if tenant construction itself fails, its first logging statement dereferences `config` and can convert the intended friendly error into a framework 500.
- Stored procedure outputs `oCode` and `oMessage` are ignored externally.
- Marker logs are written even when `enableLogging=0`; the flag only gates REQUEST/jsonRequest/ActionCode/RESPONSE blocks.
- Current wildcard ordering prevents the explicit `SELF` tenant from being selected.
- The source archive contains historical logs holding sensitive request data/credentials. They are deliberately excluded from the Node package.
- The diagnostic GET reports `Is IP Whitelisted: False` for a caller it just admitted. The gate calls
  `isIPWhitelisted(ip, true)` but the summary renders `isIPWhitelisted(ip)` with `checkStarCondition` defaulted to
  false, and with `whitelistedIPs='*'` that branch returns false. Display-only; the access decision is unaffected.
- A blank `<logType></logType>` coerces to `0`, i.e. HTML - not text. The `SELF` tenant would therefore log as HTML
  if it were ever selected.
- A request body larger than the body limit returns **500**, not 413: the error handler returns the generic Web API
  payload for every unhandled error and ignores `err.status`.
- Tenant log writes are synchronous and unguarded, so a full disk or a permissions failure on the log directory can
  turn a successful request into a failure. Logging can take the API down.
- Every tenant shares one database identity: the Oracle pool uses `ORACLE_USER`/`ORACLE_PASSWORD` from the
  environment, not the per-tenant `targetDBConnectionString` decrypted from `config.xml`.

## Cross-platform substitutions / limits

- `logType=2` Windows Event Log has no direct portable Linux equivalent. The supplied tenants use types 0 and 1. If type 2 appears, this build emits to stderr by default (configurable to stdout) and records this as the only platform substitution.
- OLE DB (`dbType=0`) is not implemented because the supplied tenants are Oracle and Node has no portable 1:1 OLE DB abstraction. It fails explicitly rather than silently choosing a different driver.
- `JsonConvert.SerializeXmlNode` has no exact Node drop-in. `fast-xml-parser` is configured for `@attribute` and `#text` conventions and repeated elements, but unusual XML edge cases should be regression-tested against real FlightView samples before cutover.
- Exact exception-message text differs between .NET/Json.NET and V8/Node for parser/driver errors. The HTTP/status control flow is preserved where feasible, but runtime-specific exception wording cannot be byte-identical.

## Production cutover checklist

1. Run `npm ci && npm run lint && npm test` (193 tests; the suite now includes characterization tests that pin
   every behavior listed above).
2. Set `TNS_ADMIN` or `ORACLE_CONFIG_DIR` so the encrypted connection string's `Data Source` alias resolves.
3. Verify DB connectivity from the Node host and execute a safe test `ActionCode` against `REQUEST_HANDLER.ACTIONS`.
4. Replay captured production requests against old/new services and compare bodies and headers, especially string content negotiation.
5. Test a representative FlightView XML response and `RESP=JSON` result side-by-side.
6. Decide explicitly whether to retain or fix the secret-leaking diagnostic GET, always-200 caught POST errors, wildcard/SELF ordering, and null-config logging bug.
7. Rotate credentials because the supplied source archive includes old logs/config material containing sensitive values.
8. **Set `ORACLE_THICK_MODE=true` and `ORACLE_CLIENT_LIB_DIR` on the existing Windows host.** Earlier builds called
   `initOracleClient()` unconditionally, so they always ran in Thick mode regardless of the flag. That call is now
   gated, and leaving the flag unset switches the service to Thin mode.
