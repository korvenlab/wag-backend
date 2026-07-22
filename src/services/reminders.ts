import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { supabase } from '../lib/supabase';
import { log } from '../lib/logger';
import { applyWhatsAppEmphasis, formatDateTimeBR } from '../lib/dateTimeBR';
import { profileSubscriptionTier } from '../lib/profileMultiBarber';
import { tierSupportsReminders } from '../lib/wagooSubscription';

dayjs.extend(utc);
dayjs.extend(timezone);

const TAG = 'REMINDER';
const TICK_MS = 60_000;
const BATCH_LIMIT = 80;
const SEND_GAP_MS = 1_200;

export type ReminderProfileSlice = {
  id: string;
  email: string;
  reminders_enabled?: boolean | null;
  remind_before_minutes?: number | null;
  subscription_tier?: unknown;
  has_paid?: unknown;
  multi_barber_plan?: boolean | null;
};

export function clampRemindBeforeMinutes(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 60;
  return Math.min(1440, Math.max(5, Math.round(n)));
}

export async function enqueueAppointmentReminder(input: {
  profile: ReminderProfileSlice;
  googleEventId: string;
  clientPhone: string;
  clientName: string;
  barberName?: string | null;
  startsAtIso: string;
}): Promise<void> {
  const tier = profileSubscriptionTier({
    subscription_tier: input.profile.subscription_tier,
    has_paid: input.profile.has_paid,
    multi_barber_plan: input.profile.multi_barber_plan,
  });

  if (!tierSupportsReminders(tier)) return;
  if (!input.profile.reminders_enabled) return;

  const phone = input.clientPhone.replace(/\D/g, '');
  if (!phone || !input.googleEventId) return;

  const minutes = clampRemindBeforeMinutes(input.profile.remind_before_minutes);
  const startsAt = dayjs(input.startsAtIso);
  if (!startsAt.isValid()) return;

  const remindAt = startsAt.subtract(minutes, 'minute');
  if (remindAt.isBefore(dayjs())) {
    log.info(TAG, 'lembrete pulado — já passou o remind_at', {
      email: input.profile.email,
      startsAt: input.startsAtIso,
      minutes,
    });
    return;
  }

  const { error } = await supabase.from('appointment_reminders').upsert(
    {
      user_id: input.profile.id,
      google_event_id: input.googleEventId,
      client_phone: phone,
      client_name: input.clientName || null,
      barber_name: input.barberName?.trim() || null,
      starts_at: startsAt.toISOString(),
      remind_at: remindAt.toISOString(),
      sent_at: null,
    },
    { onConflict: 'user_id,google_event_id' },
  );

  if (error) {
    log.error(TAG, 'falha ao enfileirar lembrete', error, {
      email: input.profile.email,
      eventId: input.googleEventId,
    });
    return;
  }

  log.info(TAG, 'lembrete enfileirado', {
    email: input.profile.email,
    remindAt: remindAt.toISOString(),
    minutes,
  });
}

export async function cancelAppointmentReminder(
  userId: string,
  googleEventId: string,
): Promise<void> {
  if (!userId || !googleEventId) return;
  const { error } = await supabase
    .from('appointment_reminders')
    .delete()
    .eq('user_id', userId)
    .eq('google_event_id', googleEventId);

  if (error) {
    log.error(TAG, 'falha ao cancelar lembrete', error, { userId, googleEventId });
  }
}

function buildReminderText(row: {
  client_name: string | null;
  barber_name: string | null;
  starts_at: string;
}): string {
  const when = formatDateTimeBR(row.starts_at);
  const name = row.client_name?.trim();
  const firstName = name ? name.split(' ')[0] : null;
  const hello = firstName ? `Oi, ${firstName}!` : 'Oi!';
  const prof =
    row.barber_name && !row.barber_name.toLowerCase().includes('sem prefer')
      ? ` com ${row.barber_name}`
      : '';
  const body =
    `${hello} Lembrete: seu horário é ${when}${prof}. Te esperamos!\n\n` +
    `Confirma que vem? Se não puder, avisa a gente.`;
  return applyWhatsAppEmphasis(body, [
    ...(firstName ? [firstName] : []),
    ...(row.barber_name ? [row.barber_name] : []),
  ]);
}

function normalizePresenceReply(text: string): 'confirmed' | 'declined' | null {
  const t = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (!t) return null;

  const declined =
    /^(nao|n|negativo|cancelar|desmarcar|nao vou|nao posso|impossivel)\b/.test(t) ||
    /\b(nao posso|nao vou|nao consigo|cancele|desmarque)\b/.test(t);
  if (declined) return 'declined';

  const confirmed =
    /^(sim|s|ok|confirmo|confirmado|pode|claro|vou|estarei|positivo)\b/.test(t) ||
    /\b(confirmar|confirmo|estarei la|estarei lá|vou sim)\b/.test(t);
  if (confirmed) return 'confirmed';

  return null;
}

/**
 * Se o cliente respondeu ao lembrete (SIM/NÃO), trata aqui e não segue para a IA.
 * Funciona mesmo com IA pausada.
 */
export async function tryHandlePresenceConfirmation(input: {
  userId: string;
  clientPhone: string;
  text: string;
  sendReply: (text: string) => Promise<void>;
}): Promise<boolean> {
  const phone = input.clientPhone.replace(/\D/g, '');
  if (!phone) return false;

  const intent = normalizePresenceReply(input.text);
  if (!intent) return false;

  const nowIso = new Date().toISOString();
  const { data: row, error } = await supabase
    .from('appointment_reminders')
    .select('id, starts_at, client_name, barber_name')
    .eq('user_id', input.userId)
    .eq('client_phone', phone)
    .eq('presence_status', 'pending')
    .not('sent_at', 'is', null)
    .gte('starts_at', nowIso)
    .order('starts_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    log.error(TAG, 'falha ao buscar lembrete pendente de presença', error);
    return false;
  }
  if (!row) return false;

  const { error: upErr } = await supabase
    .from('appointment_reminders')
    .update({
      presence_status: intent,
      presence_replied_at: new Date().toISOString(),
    })
    .eq('id', row.id)
    .eq('presence_status', 'pending');

  if (upErr) {
    log.error(TAG, 'falha ao gravar presença', upErr, { id: row.id });
    return false;
  }

  const when = formatDateTimeBR(row.starts_at as string);
  const firstName = String(row.client_name || '')
    .trim()
    .split(/\s+/)[0];
  const hello = firstName ? `${firstName}, ` : '';

  if (intent === 'confirmed') {
    await input.sendReply(
      `${hello}presença confirmada para ${when}. Te esperamos!`,
    );
  } else {
    await input.sendReply(
      `${hello}registramos que você não poderá vir em ${when}. Se quiser remarcar, é só pedir um novo horário.`,
    );
  }

  log.info(TAG, 'presença respondida', { id: row.id, intent, phone });
  return true;
}

async function processDueReminders(): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data: due, error } = await supabase
    .from('appointment_reminders')
    .select(
      'id, user_id, google_event_id, client_phone, client_name, barber_name, starts_at, remind_at',
    )
    .is('sent_at', null)
    .lte('remind_at', nowIso)
    .order('remind_at', { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    log.error(TAG, 'falha ao buscar due', error);
    return;
  }
  if (!due?.length) return;

  const { sessions } = await import('./whatsapp');

  const userIds = [...new Set(due.map((r) => r.user_id as string))];
  const { data: profiles, error: pErr } = await supabase
    .from('profiles')
    .select(
      'id, email, reminders_enabled, subscription_tier, has_paid, multi_barber_plan, complimentary_access_until',
    )
    .in('id', userIds);

  if (pErr) {
    log.error(TAG, 'falha ao carregar profiles dos lembretes', pErr);
    return;
  }

  const byId = new Map((profiles ?? []).map((p) => [p.id as string, p]));

  for (const row of due) {
    const profile = byId.get(row.user_id as string);
    if (!profile?.email) continue;

    const tier = profileSubscriptionTier({
      subscription_tier: profile.subscription_tier,
      has_paid: profile.has_paid,
      multi_barber_plan: profile.multi_barber_plan,
    });

    if (!tierSupportsReminders(tier) || !profile.reminders_enabled) {
      await supabase.from('appointment_reminders').delete().eq('id', row.id);
      continue;
    }

    const sock = sessions[profile.email as string];
    if (!sock?.user) {
      log.info(TAG, 'WA offline — deixa para o próximo tick', { email: profile.email });
      continue;
    }

    const phone = String(row.client_phone || '').replace(/\D/g, '');
    if (!phone) {
      await supabase.from('appointment_reminders').delete().eq('id', row.id);
      continue;
    }

    const jid = `${phone}@s.whatsapp.net`;
    const text = buildReminderText({
      client_name: row.client_name as string | null,
      barber_name: row.barber_name as string | null,
      starts_at: row.starts_at as string,
    });

    try {
      await sock.sendMessage(jid, { text });
      const { error: upErr } = await supabase
        .from('appointment_reminders')
        .update({
          sent_at: new Date().toISOString(),
          presence_status: 'pending',
          presence_replied_at: null,
        })
        .eq('id', row.id)
        .is('sent_at', null);

      if (upErr) {
        log.error(TAG, 'enviado mas falhou ao marcar sent_at', upErr, { id: row.id });
      } else {
        log.info(TAG, 'lembrete enviado', { email: profile.email, phone, id: row.id });
      }
    } catch (err) {
      log.error(TAG, 'falha ao enviar lembrete', err, { email: profile.email, phone });
    }

    await new Promise((r) => setTimeout(r, SEND_GAP_MS));
  }
}

let workerStarted = false;

export function startReminderWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  log.info(TAG, 'worker iniciado', { tickMs: TICK_MS, batch: BATCH_LIMIT });

  const tick = () => {
    void processDueReminders().catch((err) => log.error(TAG, 'tick falhou', err));
  };

  setTimeout(tick, 15_000);
  setInterval(tick, TICK_MS);
}
