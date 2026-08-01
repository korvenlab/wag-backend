import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { supabase } from '../lib/supabase';
import { stripe, frontendBaseUrl } from '../lib/stripeClient';
import { BR_TZ } from '../lib/dateTimeBR';
import {
  BOOKING_PAYMENT_HOLD_MINUTES,
  brlToCents,
  centsToBrl,
  computeApplicationFeeCents,
  computeDepositBrl,
  buildFeeSchedulePayload,
} from '../lib/connectFees';
import { log } from '../lib/logger';

dayjs.extend(utc);
dayjs.extend(timezone);

export type DepositCheckoutSource = 'agenda_web' | 'ai';

export type CreateDepositCheckoutInput = {
  profileId: string;
  stripeConnectAccountId: string;
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
  /** Metadados extras no Checkout (barbeiro IA, etc.) */
  extraMetadata?: Record<string, string>;
  successPath?: string;
  cancelPath?: string;
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
 * Cria agendamento pending_payment + Checkout Connect (taxa Wagoo 2%).
 * Usado por Agenda Web pública e pelo fluxo WhatsApp IA.
 */
export async function createBookingDepositCheckout(
  input: CreateDepositCheckoutInput,
): Promise<CreateDepositCheckoutResult> {
  const totalRounded = Math.round(Number(input.totalPriceBrl) * 100) / 100;
  if (totalRounded <= 0) {
    return { ok: false, error: 'Serviço sem preço. Cadastre o preço em Serviços.' };
  }

  const depositBrl = computeDepositBrl(totalRounded, input.depositPercent);
  const depositCents = brlToCents(depositBrl);
  const feeCents = computeApplicationFeeCents(depositCents);
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

  const base = frontendBaseUrl();
  const slug = (input.bookingSlug || '').trim() || 'agenda';
  const slugEnc = encodeURIComponent(slug);
  const successPath =
    input.successPath || `/a/${slugEnc}?pago=1&appointment=${appt.id}`;
  const cancelPath =
    input.cancelPath || `/a/${slugEnc}?pagamento=cancelado&appointment=${appt.id}`;

  const meta = {
    wagoo_payment: 'booking_deposit',
    appointment_id: String(appt.id),
    profile_id: String(input.profileId),
    supabase_user_id: String(input.profileId),
    source: input.source,
    ...(input.extraMetadata || {}),
  };

  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'brl',
              unit_amount: depositCents,
              product_data: {
                name: `Sinal — ${input.storeName || 'Agendamento'}`,
                description: `${input.serviceLabel} · ${input.clientName} · ${startsAt
                  .tz(BR_TZ)
                  .format('DD/MM HH:mm')}`,
              },
            },
          },
        ],
        payment_method_types: ['card', 'pix'],
        payment_intent_data: {
          application_fee_amount: feeCents,
          metadata: meta,
        },
        metadata: meta,
        expires_at: Math.floor(Date.now() / 1000) + BOOKING_PAYMENT_HOLD_MINUTES * 60,
        success_url: `${base}${successPath}`,
        cancel_url: `${base}${cancelPath}`,
        locale: 'pt-BR',
      },
      { stripeAccount: input.stripeConnectAccountId },
    );

    await supabase
      .from('booking_appointments')
      .update({ stripe_checkout_session_id: session.id })
      .eq('id', appt.id);

    if (!session.url) {
      await supabase
        .from('booking_appointments')
        .update({ status: 'cancelled', payment_status: 'failed' })
        .eq('id', appt.id);
      return { ok: false, error: 'Não foi possível abrir o pagamento.' };
    }

    return {
      ok: true,
      appointmentId: String(appt.id),
      checkoutUrl: session.url,
      depositBrl,
      feeSchedule: buildFeeSchedulePayload(depositBrl),
    };
  } catch (err) {
    log.error('BOOKING_PAY', 'checkout Connect falhou', err, { appointmentId: appt.id });
    await supabase
      .from('booking_appointments')
      .update({ status: 'cancelled', payment_status: 'failed' })
      .eq('id', appt.id);
    const message = err instanceof Error ? err.message : 'Falha ao criar pagamento.';
    return { ok: false, error: message };
  }
}

export function profileRequiresDeposit(profile: {
  booking_deposit_enabled?: boolean | null;
  stripe_connect_charges_enabled?: boolean | null;
  stripe_connect_account_id?: string | null;
}): boolean {
  return Boolean(
    profile.booking_deposit_enabled &&
      profile.stripe_connect_charges_enabled &&
      profile.stripe_connect_account_id,
  );
}
