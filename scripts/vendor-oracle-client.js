'use strict';

/**
 * Downloads and trims Oracle Instant Client into `vendor/oracle/` at build time.
 *
 * WHY THIS EXISTS
 * ---------------
 * This database is reached through an Oracle Connection Manager hop
 * (`SOURCE_ROUTE=YES` in the connect descriptor). node-oracledb's Thin mode does not
 * implement source routing: it negotiates the TNS protocol with the CMAN itself
 * rather than the database behind it, and rejects the result with NJS-138. Thick
 * mode is therefore mandatory, and Thick mode needs these libraries.
 *
 * The archive is fetched during the build instead of being committed because the
 * unpacked tree is ~103MB - past GitHub's file-size warning and pointless to store in
 * version history. `vendor/lib/libaio.so.1` IS committed: it is 16KB, and extracting
 * it from an RPM during a build would need tooling the build image may not have.
 *
 * VERSION CHOICE IS DELIBERATE - DO NOT BUMP TO 23ai
 * -------------------------------------------------
 * The target database is Oracle 12.2. Oracle certifies Instant Client 21.x against
 * database 12.1 and later; Instant Client 23ai only supports 19c and later. Moving to
 * 23ai would drop support for this database.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const IC_VERSION = '21.13.0.0.0';
const IC_URL =
  'https://download.oracle.com/otn_software/linux/instantclient/2113000/' +
  `instantclient-basiclite-linux.x64-${IC_VERSION}dbru.zip`;

const projectRoot = path.resolve(__dirname, '..');
const vendorDir = path.join(projectRoot, 'vendor', 'oracle');
const markerFile = path.join(vendorDir, 'libclntsh.so');

/**
 * Files node-oracledb never loads. Dropping them takes the tree from ~117MB to
 * ~102MB, which matters against Vercel's 250MB unzipped function ceiling:
 *  - *.jar        the JDBC/UCP drivers, for Java callers
 *  - libocci*     the C++ interface; node-oracledb uses the C API (libclntsh)
 *
 * The last two patterns drop the backward-compatibility SONAME aliases
 * (libclntsh.so.10.1 ... .20.1, libclntshcore.so.12.1 ... .20.1). They are symlinks
 * to the single real .21.1 file and exist only for binaries linked against an older
 * Oracle Client; nothing in this stack is. They are removed for a size reason rather
 * than a correctness one: Vercel's includeFiles glob may DEREFERENCE symlinks when
 * bundling, and seven aliases to an 80MB library would be copied as seven 80MB
 * files - about 615MB, far past the ceiling. Keeping one alias each caps the worst
 * case near 180MB.
 *
 * `libclntsh.so` itself must survive: it is the plain name ODPI-C dlopen()s, and it
 * is this script's completion marker.
 */
const PRUNE_PATTERNS = [/\.jar$/, /^libocci/, /^libclntsh\.so\.(?!21\.1$)/, /^libclntshcore\.so\.(?!21\.1$)/];

function log(message) {
  console.log(`[vendor-oracle-client] ${message}`);
}

async function download(url, destination) {
  log(`downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} ${response.statusText}`);
  }
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
  const megabytes = (fs.statSync(destination).size / 1024 / 1024).toFixed(1);
  log(`downloaded ${megabytes}MB`);
}

/**
 * `unzip` is used rather than a Node library so the build takes no extra dependency.
 * If a future build image lacks it this throws with the reason stated, rather than
 * failing later as a confusing DPI-1047 at runtime.
 */
function unzip(archive, intoDir) {
  try {
    execFileSync('unzip', ['-q', '-o', archive, '-d', intoDir], { stdio: 'inherit' });
  } catch (error) {
    throw new Error(
      `could not run 'unzip' (${error.message}). The build image must provide it to unpack ` +
        'the Oracle Instant Client archive.'
    );
  }
}

/**
 * Recursively copies `src` into `dest`, rewriting any symlink so its target is
 * relative to its own directory instead of carrying over the path it had under
 * `srcRoot`.
 *
 * Two problems forced this instead of `fs.cpSync(src, dest, { recursive: true })`:
 *
 * 1. `fs.cpSync` is flagged experimental below Node 22.3 (`engines` here pins
 *    >=20.0.0), so eslint's node-builtins rule rejects it outright.
 * 2. More importantly, `cpSync` preserves a symlink's target VERBATIM. The
 *    versioned files here (`libclntsh.so.21.1` etc.) are real; the unversioned
 *    names (`libclntsh.so`) are symlinks to them, and after extraction those
 *    symlinks resolve through the OS temp directory the archive was unzipped
 *    into. `main()` deletes that temp directory once this script finishes -
 *    a straight `cpSync` copy leaves `vendor/oracle/libclntsh.so` dangling from
 *    that moment on, which is silent at build time and only surfaces as
 *    DPI-1047 at runtime. Rewriting each symlink to point at its sibling by
 *    filename keeps the tree correct independent of where it was built.
 */
function copyTree(src, dest, srcRoot, destRoot) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isSymbolicLink()) {
      const rawTarget = fs.readlinkSync(srcPath);
      const absoluteTarget = path.resolve(path.dirname(srcPath), rawTarget);
      // destRoot, not dest: dest is the CURRENT directory being written, which
      // shifts on every recursive call and would misplace the rebuilt target for
      // anything not at the top level.
      const newAbsoluteTarget = path.join(destRoot, path.relative(srcRoot, absoluteTarget));
      fs.symlinkSync(path.relative(path.dirname(destPath), newAbsoluteTarget), destPath);
    } else if (entry.isDirectory()) {
      copyTree(srcPath, destPath, srcRoot, destRoot);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** The archive unpacks to `instantclient_21_13/`; flatten that into vendor/oracle/. */
function flatten(extractDir) {
  // isDirectory() is load-bearing: the downloaded archive lives in this same temp
  // directory and its name also begins with "instantclient", so a name-only match
  // picks up the zip file and every later step fails.
  const inner = fs
    .readdirSync(extractDir, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.startsWith('instantclient'));
  if (!inner) throw new Error(`no instantclient_* directory inside the archive at ${extractDir}`);

  const innerDir = path.join(extractDir, inner.name);
  copyTree(innerDir, vendorDir, innerDir, vendorDir);
}

function prune() {
  let removed = 0;
  for (const entry of fs.readdirSync(vendorDir)) {
    if (PRUNE_PATTERNS.some((pattern) => pattern.test(entry))) {
      fs.rmSync(path.join(vendorDir, entry), { force: true });
      removed += 1;
    }
  }
  log(`pruned ${removed} unused files`);
}

/**
 * libclntsh.so declares libaio.so.1 as a DT_NEEDED dependency and carries an $ORIGIN
 * RUNPATH, so a copy sitting in this same directory resolves without LD_LIBRARY_PATH.
 * Amazon Linux's Lambda image does not ship libaio.
 */
function installLibaio() {
  const source = path.join(projectRoot, 'vendor', 'lib', 'libaio.so.1');
  if (!fs.existsSync(source)) {
    throw new Error(`missing committed dependency ${source}`);
  }
  fs.copyFileSync(source, path.join(vendorDir, 'libaio.so.1'));
  log('installed libaio.so.1 alongside libclntsh.so');
}

function directorySizeMb(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // lstat, not stat: the versioned libclntsh.so.* entries are symlinks to one 80MB
    // file and must not be counted repeatedly.
    total += fs.lstatSync(path.join(dir, entry.name)).size;
  }
  return (total / 1024 / 1024).toFixed(1);
}

async function main() {
  if (fs.existsSync(markerFile)) {
    log(`already present at ${vendorDir}, skipping download`);
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ic-'));
  const archive = path.join(tempDir, 'instantclient.zip');

  await download(IC_URL, archive);
  unzip(archive, tempDir);
  fs.mkdirSync(path.dirname(vendorDir), { recursive: true });
  flatten(tempDir);
  prune();
  installLibaio();
  fs.rmSync(tempDir, { recursive: true, force: true });

  log(`ready: ${vendorDir} (${directorySizeMb(vendorDir)}MB)`);
}

main().catch((error) => {
  console.error(`[vendor-oracle-client] FAILED: ${error.message}`);
  process.exit(1);
});
