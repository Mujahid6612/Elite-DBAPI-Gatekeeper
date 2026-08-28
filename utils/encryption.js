'use strict';

const crypto = require('crypto');
const envConfig = require('../config/env');

/**
 * Key material for the `connectionString` values in config/tenants.jsonc.
 *
 * THE PASSPHRASE COMES FROM THE ENVIRONMENT. It used to be a constant in
 * config/configReader.js, sitting beside the ciphertext it protected, so anyone who
 * could clone the repository could decrypt every connection string. Sourcing it from
 * CONFIG_ENCRYPTION_KEY is what makes committing the ciphertext safe.
 *
 * The salt, IV, digest and iteration count are NOT secrets - they only have to match
 * between encrypt and decrypt - so they stay as documented values. They are also the
 * exact legacy parameters, so setting CONFIG_ENCRYPTION_KEY to the old passphrase
 * decrypts existing ciphertext unchanged during migration.
 */
function configCipherParams() {
  return {
    passPhrase: envConfig.configEncryptionKey,
    saltValue: envConfig.configEncryptionSalt,
    hashAlgorithm: 'MD5',
    passwordIterations: 2,
    initVector: '0123456789012345',
    keySize: 256
  };
}

/** Thrown when a block carries ciphertext but no passphrase is configured. */
function assertPassphrase(passPhrase) {
  if (String(passPhrase || '').trim() !== '') return;
  const error = new Error(
    'CONFIG_ENCRYPTION_KEY is not set, so an encrypted connectionString in ' +
      'config/tenants.jsonc cannot be decrypted. Set it in the environment, or remove ' +
      'the ciphertext and use envPrefix instead.'
  );
  error.name = 'ConfigurationError';
  throw error;
}

function hash(algorithm, buffer) {
  return crypto.createHash(algorithm.toLowerCase()).update(buffer).digest();
}

/**
 * Reproduces the legacy System.Security.Cryptography.PasswordDeriveBytes
 * GetBytes() behavior used by this project. This is intentionally NOT PBKDF2.
 */
function passwordDeriveBytes(password, salt, hashAlgorithm, iterations, byteCount) {
  const algorithm = String(hashAlgorithm || 'MD5').toLowerCase();
  const passwordBytes = Buffer.from(String(password), 'utf8');
  const saltBytes = Buffer.from(String(salt), 'ascii');

  let baseValue = hash(algorithm, Buffer.concat([passwordBytes, saltBytes]));
  for (let i = 1; i < Number(iterations) - 1; i += 1) {
    baseValue = hash(algorithm, baseValue);
  }

  const chunks = [];
  let total = 0;
  let prefix = 0;
  while (total < byteCount) {
    const prefixBytes = prefix === 0 ? Buffer.alloc(0) : Buffer.from(String(prefix), 'ascii');
    const block = hash(algorithm, Buffer.concat([prefixBytes, baseValue]));
    chunks.push(block);
    total += block.length;
    prefix += 1;
  }
  return Buffer.concat(chunks).subarray(0, byteCount);
}

/**
 * @param {string} cipherText base64 ciphertext
 * @param {...*} overrides explicit key material, for tests and the legacy parity suite
 */
function decryptString(cipherText, passPhrase, saltValue, hashAlgorithm, passwordIterations, initVector, keySize) {
  const defaults = configCipherParams();
  passPhrase = passPhrase === undefined ? defaults.passPhrase : passPhrase;
  saltValue = saltValue === undefined ? defaults.saltValue : saltValue;
  hashAlgorithm = hashAlgorithm === undefined ? defaults.hashAlgorithm : hashAlgorithm;
  passwordIterations = passwordIterations === undefined ? defaults.passwordIterations : passwordIterations;
  initVector = initVector === undefined ? defaults.initVector : initVector;
  keySize = keySize === undefined ? defaults.keySize : keySize;
  assertPassphrase(passPhrase);
  const key = passwordDeriveBytes(passPhrase, saltValue, hashAlgorithm, passwordIterations, keySize / 8);
  const iv = Buffer.from(initVector, 'ascii');
  const decipher = crypto.createDecipheriv(`aes-${keySize}-cbc`, key, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(Buffer.from(String(cipherText), 'base64')), decipher.final()]).toString('utf8');
}

function encryptString(plainText, passPhrase, saltValue, hashAlgorithm, passwordIterations, initVector, keySize) {
  const defaults = configCipherParams();
  passPhrase = passPhrase === undefined ? defaults.passPhrase : passPhrase;
  saltValue = saltValue === undefined ? defaults.saltValue : saltValue;
  hashAlgorithm = hashAlgorithm === undefined ? defaults.hashAlgorithm : hashAlgorithm;
  passwordIterations = passwordIterations === undefined ? defaults.passwordIterations : passwordIterations;
  initVector = initVector === undefined ? defaults.initVector : initVector;
  keySize = keySize === undefined ? defaults.keySize : keySize;
  assertPassphrase(passPhrase);
  const key = passwordDeriveBytes(passPhrase, saltValue, hashAlgorithm, passwordIterations, keySize / 8);
  const iv = Buffer.from(initVector, 'ascii');
  const cipher = crypto.createCipheriv(`aes-${keySize}-cbc`, key, iv);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(Buffer.from(String(plainText), 'utf8')), cipher.final()]).toString('base64');
}

module.exports = { passwordDeriveBytes, decryptString, encryptString, configCipherParams };
