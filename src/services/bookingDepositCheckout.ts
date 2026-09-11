import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { supabase } from '../lib/supabase';
import { frontendBaseUrl } from '../lib/stripeClient';
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
  /** @deprecated Stripe Connect — ignorado; use mpSellerReady no perfil. */
  stripeConnectAccountId?: string | null;
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
 * Cria agendamento pending_payment e devolve URL da tela interna Wagoo
 * (Checkout Transparente Mercado Pago — PIX/cartão).
 */
export async function createBookingDepositCheckout(
  input: CreateDepositCheckoutInput,
): Promise<CreateDepositCheckoutResult> {
  const totalRounded = Math.round(Number(input.totalPriceBrl) * 100) / 100;
  if (totalRounded <= 0) {
    return { ok: false, error: 'Serviço sem preço. Cadastre o preço em Serviços.' };
  }

  const { data: seller, error: sellerErr } = await supabase
    .from('profiles')
    .select('mp_user_id, mp_access_token')
    .eq('id', input.profileId)
    .maybeSingle();

  if (sellerErr || !seller?.mp_access_token || !seller?.mp_user_id) {
    return {
      ok: false,
      error: 'Salão ainda não vinculou o Mercado Pago para receber sinais.',
    };
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
  const checkoutUrl = `${base}/a/${slugEnc}/pagar/${appt.id}`;

  log.info('BOOKING_PAY', 'checkout MP (página interna)', {
    appointmentId: appt.id,
    depositBrl,
    startsAt: startsAt.tz(BR_TZ).format('DD/MM HH:mm'),
  });

  return {
    ok: true,
    appointmentId: String(appt.id),
    checkoutUrl,
    depositBrl,
    feeSchedule: buildFeeSchedulePayload(depositBrl),
  };
}

export function profileHasMercadoPagoReady(profile: {
  mp_user_id?: string | null;
  mp_access_token?: string | null;
}): boolean {
  return Boolean(profile.mp_user_id && profile.mp_access_token);
}

export function profileRequiresDeposit(profile: {
  booking_deposit_enabled?: boolean | null;
  mp_user_id?: string | null;
  mp_access_token?: string | null;
  /** legado Stripe — só conta se MP não estiver ligado e Stripe ainda ativo */
  stripe_connect_charges_enabled?: boolean | null;
  stripe_connect_account_id?: string | null;
}): boolean {
  if (!profile.booking_deposit_enabled) return false;
  if (profileHasMercadoPagoReady(profile)) return true;
  return Boolean(
    profile.stripe_connect_charges_enabled && profile.stripe_connect_account_id,
  );
}
