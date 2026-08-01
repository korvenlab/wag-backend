/** Taxa da plataforma Wagoo sobre cada pagamento de cliente (sinal/depósito). */
export const WAGOO_APPLICATION_FEE_PERCENT = 2;

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
  // Mínimo R$ 1,00 se o total for > 0 (Stripe Checkout)
  if (total > 0 && deposit < 1) return 1;
  return deposit;
}

/**
 * Taxa Wagoo (application_fee) em centavos.
 * A taxa de processamento Stripe é cobrada automaticamente na conta Connect
 * (modelo SaaS / direct charge) — não entra neste valor.
 */
export function computeApplicationFeeCents(depositCents: number): number {
  if (depositCents <= 0) return 0;
  const fee = Math.round((depositCents * WAGOO_APPLICATION_FEE_PERCENT) / 100);
  // Stripe exige application_fee_amount >= 0 e < amount; mínimo 1 centavo se houver cobrança
  if (fee < 1 && depositCents >= 2) return 1;
  if (fee >= depositCents) return Math.max(0, depositCents - 1);
  return fee;
}
