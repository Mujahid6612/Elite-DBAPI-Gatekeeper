'use strict';

const crypto = require('crypto');

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

function decryptString(
  cipherText,
  passPhrase = 'SoundViewTechEncryption',
  saltValue = 'svtlhr',
  hashAlgorithm = 'MD5',
  passwordIterations = 2,
  initVector = '0123456789012345',
  keySize = 256
) {
  const key = passwordDeriveBytes(passPhrase, saltValue, hashAlgorithm, passwordIterations, keySize / 8);
  const iv = Buffer.from(initVector, 'ascii');
  const decipher = crypto.createDecipheriv(`aes-${keySize}-cbc`, key, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(Buffer.from(String(cipherText), 'base64')), decipher.final()]).toString('utf8');
}

function encryptString(
  plainText,
  passPhrase = 'SoundViewTechEncryption',
  saltValue = 'svtlhr',
  hashAlgorithm = 'MD5',
  passwordIterations = 2,
  initVector = '0123456789012345',
  keySize = 256
) {
  const key = passwordDeriveBytes(passPhrase, saltValue, hashAlgorithm, passwordIterations, keySize / 8);
  const iv = Buffer.from(initVector, 'ascii');
  const cipher = crypto.createCipheriv(`aes-${keySize}-cbc`, key, iv);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(Buffer.from(String(plainText), 'utf8')), cipher.final()]).toString('base64');
}

module.exports = { passwordDeriveBytes, decryptString, encryptString };
