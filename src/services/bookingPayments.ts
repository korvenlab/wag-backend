import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { supabase } from '../lib/supabase';
import { BR_TZ, formatDateTimeBR, applyWhatsAppEmphasis } from '../lib/dateTimeBR';
import { parseAiBookingNotes } from '../lib/bookingCatalog';
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
  asaasPaymentId?: string | null;
  depositAmountBrl?: number | null;
}): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  const { data: appt, error } = await supabase
    .from('booking_appointments')
    .select(
      'id, profile_id, status, payment_status, client_name, client_phone, starts_at, ends_at, notes, provider_id, google_event_id, price_brl, service_id, deposit_amount_brl, asaas_payment_id',
    )
    .eq('id', opts.appointmentId)
    .maybeSingle();

  if (error || !appt) {
    return { ok: false, error: error?.message || 'Agendamento não encontrado.' };
  }

  if (appt.status === 'confirmed' && appt.payment_status === 'paid') {
    // Ainda tenta crédito idempotente se o webhook anterior falhou no ledger.
    if (opts.asaasPaymentId && appt.profile_id) {
      const gross =
        Number(opts.depositAmountBrl) ||
        Number(appt.deposit_amount_brl) ||
        0;
      if (gross > 0) {
        const { creditClubLedgerFromPayment } = await import('../lib/clubLedger');
        await creditClubLedgerFromPayment({
          profileId: String(appt.profile_id),
          clubMemberId: null,
          grossBrl: gross,
          asaasPaymentId: opts.asaasPaymentId,
          description: 'Sinal de agendamento (Asaas)',
        });
      }
    }
    return { ok: true, already: true };
  }

  if (appt.status === 'cancelled') {
    return { ok: false, error: 'Agendamento cancelado.' };
  }

  // Não aceita payment id diferente do já vinculado
  if (
    appt.asaas_payment_id &&
    opts.asaasPaymentId &&
    String(appt.asaas_payment_id) !== String(opts.asaasPaymentId)
  ) {
    return { ok: false, error: 'Pagamento não corresponde a este agendamento.' };
  }

  const patch: Record<string, unknown> = {
    status: 'confirmed',
    payment_status: 'paid',
    paid_at: new Date().toISOString(),
  };
  if (opts.paymentIntentId) patch.stripe_payment_intent_id = opts.paymentIntentId;
  if (opts.checkoutSessionId) patch.stripe_checkout_session_id = opts.checkoutSessionId;
  if (opts.asaasPaymentId) patch.asaas_payment_id = opts.asaasPaymentId;

  const { error: upErr } = await supabase
    .from('booking_appointments')
    .update(patch)
    .eq('id', appt.id);

  if (upErr) return { ok: false, error: upErr.message };

  // Credita ledger do salão (mesmo wallet do clube)
  const gross =
    Number(opts.depositAmountBrl) ||
    Number(appt.deposit_amount_brl) ||
    0;
  if (opts.asaasPaymentId && gross > 0 && appt.profile_id) {
    try {
      const { creditClubLedgerFromPayment } = await import('../lib/clubLedger');
      await creditClubLedgerFromPayment({
        profileId: String(appt.profile_id),
        clubMemberId: null,
        grossBrl: gross,
        asaasPaymentId: opts.asaasPaymentId,
        description: 'Sinal de agendamento (Asaas)',
      });
    } catch (err) {
      log.error('BOOKING_PAY', 'ledger crédito falhou', err, {
        appointmentId: appt.id,
      });
    }
  }

  const [{ data: owner }, { data: provider }, { data: service }] = await Promise.all([
    supabase
      .from('profiles')
      .select('email, googleAuth, store_name, response_templates')
      .eq('id', appt.profile_id)
      .maybeSingle(),
    appt.provider_id
      ? supabase.from('booking_providers').select('name').eq('id', appt.provider_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from('booking_services')
      .select('name, duration_minutes')
      .eq('id', appt.service_id)
      .maybeSingle(),
  ]);

  const aiMeta = parseAiBookingNotes(appt.notes as string | null);
  const isAiSource = aiMeta.source === 'ai';

  const serviceNames =
    (appt.notes && String(appt.notes).startsWith('Serviços:')
      ? String(appt.notes).replace(/^Serviços:\s*/, '')
      : service?.name) || 'Serviço';
  const providerName =
    provider?.name
      ? String(provider.name)
      : aiMeta.barberName || null;
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
          barberEmail: aiMeta.barberEmail || undefined,
          serviceNames: service?.name || serviceNames,
          source: isAiSource ? 'ai' : 'agenda_web',
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

  if (isAiSource && owner?.email) {
    try {
      const { clearAiSchedulingPending, sessions } = await import('./whatsapp');
      clearAiSchedulingPending(String(owner.email), String(appt.client_phone));

      const phone = String(appt.client_phone).replace(/\D/g, '');
      const sock = sessions[String(owner.email)];
      if (sock?.user && phone) {
        const when = formatDateTimeBR(String(appt.starts_at));
        const firstName =
          String(appt.client_name).trim().split(/\s+/)[0] || null;
        const hello = firstName ? `Oi, ${firstName}!` : 'Oi!';
        const svc = service?.name || serviceNames;
        const prof =
          providerName && !providerName.toLowerCase().includes('sem prefer')
            ? ` com ${providerName}`
            : '';
        const text = applyWhatsAppEmphasis(
          `${hello} Pagamento recebido — sinal ok.\n\n` +
            `Horário *confirmado*: ${when}${prof}\n` +
            (svc ? `Serviço: *${svc}*\n` : '') +
            `\nTe esperamos!`,
          [
            ...(firstName ? [firstName] : []),
            ...(providerName ? [providerName] : []),
            ...(svc ? [svc] : []),
          ],
        );
        await sock.sendMessage(`${phone}@s.whatsapp.net`, { text });
        log.info('BOOKING_PAY', 'confirmação IA enviada no WhatsApp', {
          appointmentId: appt.id,
          phone,
        });
      }
    } catch (err) {
      log.error('BOOKING_PAY', 'falha ao confirmar IA no WhatsApp', err, {
        appointmentId: appt.id,
      });
    }
  }

  void notifyWebBookingCreated({
    ownerUserId: String(appt.profile_id),
    appointmentId: String(appt.id),
    clientName: String(appt.client_name),
    clientPhone: String(appt.client_phone),
    startsAtIso: String(appt.starts_at),
    storeName: String(owner?.store_name || 'Negócio'),
    serviceNames: service?.name || serviceNames,
    providerName,
    /** IA já mandou a mensagem de pagamento; Agenda Web manda a confirmação padrão. */
    skipWhatsApp: isAiSource,
  });

  if (isAiSource) {
    const { data: stats } = await supabase
      .from('profiles')
      .select('appointments_made, appointments_count')
      .eq('id', appt.profile_id)
      .maybeSingle();
    if (stats) {
      await supabase
        .from('profiles')
        .update({
          appointments_made: (Number(stats.appointments_made) || 0) + 1,
          appointments_count: (Number(stats.appointments_count) || 0) + 1,
        })
        .eq('id', appt.profile_id);
    }
  }

  log.info('BOOKING_PAY', 'sinal pago — agendamento confirmado', {
    appointmentId: appt.id,
    source: isAiSource ? 'ai' : 'agenda_web',
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
