import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { supabase } from '../lib/supabase';
import { frontendBaseUrl } from '../lib/stripeClient';
import { BR_TZ } from '../lib/dateTimeBR';
import {
  BOOKING_PAYMENT_HOLD_MINUTES,
  computeDepositBrl,
  buildFeeSchedulePayload,
  computeApplicationFeeCents,
  brlToCents,
  centsToBrl,
} from '../lib/connectFees';
import { log } from '../lib/logger';
import {
  asaasConfigured,
  asaasCreateCustomer,
  asaasCreatePayment,
  todayIsoDateSaoPaulo,
} from '../lib/asaasClient';

dayjs.extend(utc);
dayjs.extend(timezone);

export type DepositCheckoutSource = 'agenda_web' | 'ai';

export type CreateDepositCheckoutInput = {
  profileId: string;
  storeName: string;
  bookingSlug: string | null;
  serviceId: string;
  providerId?: string | null;
  clientName: string;
  clientPhone: string;
  startsAtIso: string;
  endsAtIso: string;
  totalPriceBrl: number;
  depositPercent: number;
  serviceLabel: string;
  notes?: string;
  source: DepositCheckoutSource;
  extraMetadata?: Record<string, string>;
};

export type CreateDepositCheckoutResult =
  | {
      ok: true;
      appointmentId: string;
      checkoutUrl: string;
      depositBrl: number;
      feeSchedule: ReturnType<typeof buildFeeSchedulePayload>;
    }
  | { ok: false; error: string };

/**
 * Cria agendamento pending_payment + cobrança Asaas (conta Wagoo).
 */
export async function createBookingDepositCheckout(
  input: CreateDepositCheckoutInput,
): Promise<CreateDepositCheckoutResult> {
  if (!asaasConfigured()) {
    return { ok: false, error: 'Pagamentos temporariamente indisponíveis.' };
  }

  const totalRounded = Math.round(Number(input.totalPriceBrl) * 100) / 100;
  if (totalRounded <= 0) {
    return { ok: false, error: 'Serviço sem preço. Cadastre o preço em Serviços.' };
  }

  const depositBrl = computeDepositBrl(totalRounded, input.depositPercent);
  const feeCents = computeApplicationFeeCents(brlToCents(depositBrl));
  const expiresAt = dayjs().add(BOOKING_PAYMENT_HOLD_MINUTES, 'minute').toISOString();
  const startsAt = dayjs(input.startsAtIso);

  const notesBase = input.notes?.trim() || '';
  const sourceTag = `source=${input.source}`;
  const notes = notesBase.includes('source=')
    ? notesBase
    : [notesBase, sourceTag].filter(Boolean).join(' | ');

  const { data: appt, error } = await supabase
    .from('booking_appointments')
    .insert({
      profile_id: input.profileId,
      service_id: input.serviceId,
      provider_id: input.providerId || null,
      client_name: input.clientName,
      client_phone: input.clientPhone.replace(/\D/g, '').slice(0, 20),
      starts_at: input.startsAtIso,
      ends_at: input.endsAtIso,
      status: 'pending_payment',
      price_brl: totalRounded,
      deposit_amount_brl: depositBrl,
      application_fee_brl: centsToBrl(feeCents),
      payment_status: 'pending',
      payment_expires_at: expiresAt,
      notes,
    })
    .select('id')
    .single();

  if (error || !appt) {
    return { ok: false, error: error?.message || 'Não foi possível reservar o horário.' };
  }

  const phone = input.clientPhone.replace(/\D/g, '').slice(0, 20);
  const externalRef = `booking_deposit:${appt.id}`.slice(0, 100);

  const customer = await asaasCreateCustomer({
    name: input.clientName,
    mobilePhone: phone,
    externalReference: externalRef,
  });

  if (!customer.ok) {
    await supabase
      .from('booking_appointments')
      .update({ status: 'cancelled', payment_status: 'failed' })
      .eq('id', appt.id);
    return { ok: false, error: customer.error };
  }

  const description =
    `Sinal — ${input.storeName || 'Agendamento'} · ${input.serviceLabel} · ${input.clientName} · ${startsAt
      .tz(BR_TZ)
      .format('DD/MM HH:mm')}`.slice(0, 500);

  const payment = await asaasCreatePayment({
    customerId: customer.data.id,
    value: depositBrl,
    dueDate: todayIsoDateSaoPaulo(),
    description,
    externalReference: externalRef,
  });

  if (!payment.ok || !payment.data.invoiceUrl) {
    await supabase
      .from('booking_appointments')
      .update({ status: 'cancelled', payment_status: 'failed' })
      .eq('id', appt.id);
    return {
      ok: false,
      error: payment.ok ? 'Fatura Asaas sem link.' : payment.error,
    };
  }

  await supabase
    .from('booking_appointments')
    .update({ asaas_payment_id: payment.data.id })
    .eq('id', appt.id);

  return {
    ok: true,
    appointmentId: String(appt.id),
    checkoutUrl: payment.data.invoiceUrl,
    depositBrl,
    feeSchedule: buildFeeSchedulePayload(depositBrl),
  };
}

export function profileRequiresDeposit(profile: {
  booking_deposit_enabled?: boolean | null;
}): boolean {
  return Boolean(profile.booking_deposit_enabled && asaasConfigured());
}

export function profileCanChargeOnline(): boolean {
  return asaasConfigured();
}
