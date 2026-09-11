import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptMpSecret, encryptMpSecret, isEncryptedMpSecret } from './mpTokenCrypto';

test('encrypt/decrypt roundtrip com chave', () => {
  process.env.MP_TOKEN_ENCRYPTION_KEY = 'unit-test-secret-key-please-change';
  const plain = 'APP_USR-test-token-123';
  const enc = encryptMpSecret(plain);
  assert.ok(enc);
  assert.equal(isEncryptedMpSecret(enc), true);
  assert.equal(decryptMpSecret(enc), plain);
  // plaintext legado passa direto
  assert.equal(decryptMpSecret('APP_USR-legacy'), 'APP_USR-legacy');
});
