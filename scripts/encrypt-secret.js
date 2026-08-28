'use strict';

/**
 * Produces the encrypted `connectionString` value for a block in config/tenants.jsonc.
 *
 *   npm run encrypt-secret -- "Data Source=ELDevWan;user id=APIUSER;password=secret;"
 *
 * Uses CONFIG_ENCRYPTION_KEY from the environment - the same passphrase the service
 * decrypts with - so a value produced here is readable by a deployment configured with
 * that key and by nothing else. Rotating the key means re-running this for every block.
 *
 * The plaintext is echoed back and verified by decrypting the result, because a
 * connection string that encrypts cleanly but decrypts to something subtly different
 * (a mangled quote, a stray newline from a copy-paste) would otherwise only surface as
 * an ORA- error at runtime.
 *
 * SHELL HISTORY. The plaintext is an argument, so it lands in your shell history.
 * Prefix the command with a space where your shell honours HISTCONTROL=ignorespace, or
 * pipe it in:  echo -n 'Data Source=…' | npm run encrypt-secret -- -
 */

const envConfig = require('../config/env');
const { encryptString, decryptString } = require('../utils/encryption');

function readPlainText(argv) {
  const arg = argv[2];

  if (arg === undefined || arg === '' || arg === '--help' || arg === '-h') return null;

  // `-` means "read from stdin", which keeps the secret out of shell history.
  if (arg === '-') {
    const stdin = require('fs').readFileSync(0, 'utf8');
    // Trailing newline from `echo` is stripped; anything else is preserved verbatim,
    // because a connection string may legitimately contain spaces.
    return stdin.replace(/\r?\n$/, '');
  }

  return arg;
}

function main() {
  const plainText = readPlainText(process.argv);

  if (plainText === null) {
    console.error('Usage: npm run encrypt-secret -- "Data Source=X;user id=U;password=P;"');
    console.error('   or: echo -n "Data Source=…" | npm run encrypt-secret -- -');
    process.exit(2);
  }

  if (!String(envConfig.configEncryptionKey || '').trim()) {
    console.error('CONFIG_ENCRYPTION_KEY is not set. Set it in .env or the environment first.');
    console.error('It must match the key the deployment decrypts with, or the value will not load.');
    process.exit(1);
  }

  const cipherText = encryptString(plainText);

  // Prove the value round-trips before anyone pastes it into a config file.
  const roundTripped = decryptString(cipherText);
  if (roundTripped !== plainText) {
    console.error('Round-trip check FAILED: the encrypted value does not decrypt to the input.');
    process.exit(1);
  }

  console.log('Verified: decrypts back to the exact input.\n');
  console.log('Paste into the block in config/tenants.jsonc:\n');
  console.log(`  "connectionString": ${JSON.stringify(cipherText)}`);
}

main();
