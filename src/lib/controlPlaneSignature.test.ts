import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlPlaneSignature } from './controlPlaneSignature';

test('assina exatamente timestamp.rawBody com HMAC SHA256 hexadecimal', () => {
  const signature = createControlPlaneSignature(
    '1725872400',
    '{"event_id":"evt_1","product":"wagoo"}',
    'secret',
  );

  assert.equal(
    signature,
    'd703bddd51dc953320ad06e994b981a8bb5a45e7e7b91a48ddbcf1f8b5c47e8b',
  );
});
