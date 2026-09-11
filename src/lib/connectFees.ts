/**
 * Taxas Wagoo + processador (Mercado Pago) — fonte única para código e UI.
 *
 * Fluxo marketplace (cobrança na conta do salão):
 * - O cliente paga o valor do sinal (sem acréscimo de taxa na tela).
 * - Wagoo recebe sempre 2% (application_fee), independente do meio.
 * - O processador desconta a taxa dele do valor que o salão recebe.
 */

/** Taxa da plataforma Wagoo sobre cada pagamento de cliente (sinal). Sempre 2%, Pix ou cartão. */
export const WAGOO_APPLICATION_FEE_PERCENT = 2;

/** Mercado Pago Pix — estimado para UI. */
export const STRIPE_PIX_FEE_PERCENT = 0.99;
export const MP_PIX_FEE_PERCENT = STRIPE_PIX_FEE_PERCENT;

/** Cartão (Mercado Pago BR, estimativa UI). */
export const STRIPE_CARD_FEE_PERCENT = 4.98;
export const MP_CARD_FEE_PERCENT = STRIPE_CARD_FEE_PERCENT;
export const STRIPE_CARD_FEE_FIXED_BRL = 0;

/** Textos curtos para UI (dono do salão / simulação). */
export const FEE_COPY = {
  wagoo: `Wagoo: ${WAGOO_APPLICATION_FEE_PERCENT}% do pagamento (Pix ou cartão).`,
  stripePix: `No Pix (Mercado Pago): ~${STRIPE_PIX_FEE_PERCENT}%.`,
  stripeCard: `No cartão (Mercado Pago): ~${STRIPE_CARD_FEE_PERCENT}%.`,
  mpPix: `No Pix (Mercado Pago): ~${MP_PIX_FEE_PERCENT}%.`,
  mpCard: `No cartão (Mercado Pago): ~${MP_CARD_FEE_PERCENT}%.`,
  summary:
    `Do sinal, a Wagoo fica com ${WAGOO_APPLICATION_FEE_PERCENT}%. ` +
    `No Pix sai ~${STRIPE_PIX_FEE_PERCENT}%; no cartão, ~${STRIPE_CARD_FEE_PERCENT}% (Mercado Pago).`,
} as const;

/** Reserva o horário enquanto o cliente está no Checkout (minutos). */
export const BOOKING_PAYMENT_HOLD_MINUTES = 30;

export function brlToCents(brl: number): number {
  return Math.round(Number(brl) * 100);
}

export function centsToBrl(cents: number): number {
  return Math.round(cents) / 100;
}

/** Valor do sinal em BRL a partir do total e do % configurado pelo salão. */
export function computeDepositBrl(totalBrl: number, depositPercent: number): number {
  const pct = Math.min(100, Math.max(1, Number(depositPercent) || 30));
  const total = Math.max(0, Number(totalBrl) || 0);
  const deposit = Math.round(((total * pct) / 100) * 100) / 100;
  if (total > 0 && deposit < 1) return 1;
  return deposit;
}

/**
 * Taxa Wagoo (application_fee) em centavos — sempre 2% do valor cobrado.
 * Independente de Pix ou cartão.
 */
export function computeApplicationFeeCents(depositCents: number): number {
  if (depositCents <= 0) return 0;
  const fee = Math.round((depositCents * WAGOO_APPLICATION_FEE_PERCENT) / 100);
  if (fee < 1 && depositCents >= 2) return 1;
  if (fee >= depositCents) return Math.max(0, depositCents - 1);
  return fee;
}

export type StripePaymentMethodFee = 'pix' | 'card';

/** Taxa Stripe estimada em centavos (sobre o valor que o cliente paga). */
export function computeStripeFeeCents(
  amountCents: number,
  method: StripePaymentMethodFee,
): number {
  if (amountCents <= 0) return 0;
  if (method === 'pix') {
    return Math.round((amountCents * STRIPE_PIX_FEE_PERCENT) / 100);
  }
  const percentPart = Math.round((amountCents * STRIPE_CARD_FEE_PERCENT) / 100);
  return percentPart + brlToCents(STRIPE_CARD_FEE_FIXED_BRL);
}

/**
 * Quanto o salão tende a receber líquido do sinal (estimativa).
 * = valor pago − 2% Wagoo − taxa Stripe (Pix ou cartão).
 */
export function estimateShopNetCents(
  depositCents: number,
  method: StripePaymentMethodFee,
): {
  wagooFeeCents: number;
  stripeFeeCents: number;
  shopNetCents: number;
} {
  const wagooFeeCents = computeApplicationFeeCents(depositCents);
  const stripeFeeCents = computeStripeFeeCents(depositCents, method);
  const shopNetCents = Math.max(0, depositCents - wagooFeeCents - stripeFeeCents);
  return { wagooFeeCents, stripeFeeCents, shopNetCents };
}

/** Payload estável de taxas para APIs e UI. */
export function buildFeeSchedulePayload(depositBrl: number) {
  const depositCents = brlToCents(depositBrl);
  const wagooFeeCents = computeApplicationFeeCents(depositCents);
  const pix = estimateShopNetCents(depositCents, 'pix');
  const card = estimateShopNetCents(depositCents, 'card');

  const processor = {
    pix: {
      percent: MP_PIX_FEE_PERCENT,
      fee_brl: centsToBrl(pix.stripeFeeCents),
      shop_receives_brl: centsToBrl(pix.shopNetCents),
      label: FEE_COPY.mpPix,
    },
    card: {
      percent: MP_CARD_FEE_PERCENT,
      fixed_brl: STRIPE_CARD_FEE_FIXED_BRL,
      fee_brl: centsToBrl(card.stripeFeeCents),
      shop_receives_brl: centsToBrl(card.shopNetCents),
      label: FEE_COPY.mpCard,
    },
  };

  return {
    deposit_brl: depositBrl,
    provider: 'mercadopago' as const,
    wagoo: {
      percent: WAGOO_APPLICATION_FEE_PERCENT,
      fee_brl: centsToBrl(wagooFeeCents),
      label: FEE_COPY.wagoo,
    },
    /** Nome canônico (MP). */
    processor,
    /** Alias legado para UIs antigas que leem `stripe.*`. */
    stripe: processor,
    summary: FEE_COPY.summary,
  };
}
