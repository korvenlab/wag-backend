import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'crypto';
import {
  MP_WEBHOOK_MAX_SKEW_SEC,
  verifyMercadoPagoWebhookSignature,
} from './mercadopagoWebhook';

function sign(opts: {
  secret: string;
  dataId: string;
  requestId: string;
  ts: string;
}): string {
  const manifest = `id:${opts.dataId.toLowerCase()};request-id:${opts.requestId};ts:${opts.ts};`;
  const v1 = createHmac('sha256', opts.secret).update(manifest).digest('hex');
  return `ts=${opts.ts},v1=${v1}`;
}

test('webhook signature válida dentro da janela', () => {
  const secret = 'test-secret';
  const dataId = '12345';
  const requestId = 'req-1';
  const now = 1_700_000_000;
  const ts = String(now);
  const xSignature = sign({ secret, dataId, requestId, ts });
  assert.equal(
    verifyMercadoPagoWebhookSignature({
      xSignature,
      xRequestId: requestId,
      dataId,
      secret,
      nowSec: now,
      maxSkewSec: MP_WEBHOOK_MAX_SKEW_SEC,
    }),
    true,
  );
});

test('webhook rejeita ts fora da janela', () => {
  const secret = 'test-secret';
  const dataId = '12345';
  const requestId = 'req-1';
  const now = 1_700_000_000;
  const ts = String(now - 10_000);
  const xSignature = sign({ secret, dataId, requestId, ts });
  assert.equal(
    verifyMercadoPagoWebhookSignature({
      xSignature,
      xRequestId: requestId,
      dataId,
      secret,
      nowSec: now,
      maxSkewSec: 300,
    }),
    false,
  );
});
