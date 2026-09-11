import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFeeSchedulePayload,
  computeApplicationFeeCents,
  WAGOO_APPLICATION_FEE_PERCENT,
} from './connectFees';

test('application fee 2% com arredondamento', () => {
  assert.equal(computeApplicationFeeCents(10000), 200);
  assert.equal(WAGOO_APPLICATION_FEE_PERCENT, 2);
});

test('fee schedule expõe processor e alias stripe', () => {
  const payload = buildFeeSchedulePayload(100);
  assert.equal(payload.provider, 'mercadopago');
  assert.equal(payload.wagoo.percent, 2);
  assert.ok(payload.processor.pix.shop_receives_brl < 100);
  assert.equal(payload.stripe.pix.fee_brl, payload.processor.pix.fee_brl);
});
