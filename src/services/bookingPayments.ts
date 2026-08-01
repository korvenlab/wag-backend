import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { supabase } from '../lib/supabase';
import { BR_TZ } from '../lib/dateTimeBR';
import { notifyWebBookingCreated } from './reminders';
import { createEvent } from './calendar';
import { log } from '../lib/logger';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Confirma agendamento após pagamento do sinal (idempotente).
 * Cria evento Google + dispara WhatsApp se ainda não estiver confirmed.
 */
export async function fulfillBookingDepositPayment(opts: {
  appointmentId: string;
  paymentIntentId?: string | null;
  checkoutSessionId?: string | null;
}): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  const { data: appt, error } = await supabase
    .from('booking_appointments')
    .select(
      'id, profile_id, status, payment_status, client_name, client_phone, starts_at, ends_at, notes, provider_id, google_event_id, price_brl, service_id',
    )
    .eq('id', opts.appointmentId)
    .maybeSingle();

  if (error || !appt) {
    return { ok: false, error: error?.message || 'Agendamento não encontrado.' };
  }

  if (appt.status === 'confirmed' && appt.payment_status === 'paid') {
    return { ok: true, already: true };
  }

  if (appt.status === 'cancelled') {
    return { ok: false, error: 'Agendamento cancelado.' };
  }

  const patch: Record<string, unknown> = {
    status: 'confirmed',
    payment_status: 'paid',
    paid_at: new Date().toISOString(),
  };
  if (opts.paymentIntentId) patch.stripe_payment_intent_id = opts.paymentIntentId;
  if (opts.checkoutSessionId) patch.stripe_checkout_session_id = opts.checkoutSessionId;

  const { error: upErr } = await supabase
    .from('booking_appointments')
    .update(patch)
    .eq('id', appt.id);

  if (upErr) return { ok: false, error: upErr.message };

  const [{ data: owner }, { data: provider }, { data: service }] = await Promise.all([
    supabase.from('profiles').select('email, googleAuth, store_name').eq('id', appt.profile_id).maybeSingle(),
    appt.provider_id
      ? supabase.from('booking_providers').select('name').eq('id', appt.provider_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('booking_services').select('name, duration_minutes').eq('id', appt.service_id).maybeSingle(),
  ]);

  const serviceNames =
    (appt.notes && String(appt.notes).startsWith('Serviços:')
      ? String(appt.notes).replace(/^Serviços:\s*/, '')
      : service?.name) || 'Serviço';
  const providerName = provider?.name ? String(provider.name) : null;
  const duration = Math.max(
    5,
    dayjs(appt.ends_at).diff(dayjs(appt.starts_at), 'minute') ||
      Number(service?.duration_minutes) ||
      30,
  );

  const googleAuth = owner?.googleAuth as { refreshToken?: string | null } | null | undefined;
  if (owner?.email && googleAuth?.refreshToken && !appt.google_event_id) {
    try {
      const created = await createEvent(
        String(owner.email),
        String(appt.client_name),
        String(appt.client_phone),
        String(appt.starts_at),
        duration,
        {
          barberName: providerName || undefined,
          serviceNames,
          source: 'agenda_web',
        },
      );
      if (created?.id) {
        await supabase
          .from('booking_appointments')
          .update({ google_event_id: created.id })
          .eq('id', appt.id);
      }
    } catch (err) {
      log.error('BOOKING_PAY', 'falha Google após pagamento', err, { appointmentId: appt.id });
    }
  }

  void notifyWebBookingCreated({
    ownerUserId: String(appt.profile_id),
    appointmentId: String(appt.id),
    clientName: String(appt.client_name),
    clientPhone: String(appt.client_phone),
    startsAtIso: String(appt.starts_at),
    storeName: String(owner?.store_name || 'Negócio'),
    serviceNames,
    providerName,
  });

  log.info('BOOKING_PAY', 'sinal pago — agendamento confirmado', {
    appointmentId: appt.id,
    startsAtBr: dayjs(appt.starts_at).tz(BR_TZ).format('DD/MM/YYYY HH:mm'),
  });

  return { ok: true };
}

export async function markBookingPaymentFailed(appointmentId: string): Promise<void> {
  await supabase
    .from('booking_appointments')
    .update({
      status: 'cancelled',
      payment_status: 'failed',
    })
    .eq('id', appointmentId)
    .eq('status', 'pending_payment');
}

export async function expireStalePendingPayments(): Promise<number> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('booking_appointments')
    .update({ status: 'cancelled', payment_status: 'expired' })
    .eq('status', 'pending_payment')
    .lt('payment_expires_at', now)
    .select('id');

  if (error) {
    log.warn('BOOKING_PAY', 'expire pending falhou', { error: error.message });
    return 0;
  }
  return data?.length ?? 0;
}
