import express, { Request, Response } from 'express';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { supabase } from '../lib/supabase';
import { BR_TZ } from '../lib/dateTimeBR';
import { profileSubscriptionTier } from '../lib/profileMultiBarber';
import { tierSupportsReminders } from '../lib/wagooSubscription';

dayjs.extend(utc);
dayjs.extend(timezone);

const router = express.Router();

export type PresenceStatus = 'pending' | 'confirmed' | 'declined' | 'none';

function weekRangeFromQuery(req: Request): { from: string; to: string; label: string } {
  const now = dayjs().tz(BR_TZ);
  const rawFrom = typeof req.query.from === 'string' ? req.query.from : '';
  const rawTo = typeof req.query.to === 'string' ? req.query.to : '';

  let start = rawFrom
    ? dayjs.tz(rawFrom, BR_TZ).startOf('day')
    : now.startOf('day').day(1);
  if (!start.isValid()) start = now.startOf('day').day(1);
  // Se hoje é domingo (0), day(1) vai para próxima segunda — corrigir para esta semana
  if (!rawFrom && now.day() === 0) {
    start = now.startOf('day').subtract(6, 'day');
  } else if (!rawFrom && now.day() !== 1) {
    start = now.startOf('day').day(1);
    if (start.isAfter(now, 'day')) start = start.subtract(7, 'day');
  }

  let end = rawTo ? dayjs.tz(rawTo, BR_TZ).endOf('day') : start.add(6, 'day').endOf('day');
  if (!end.isValid()) end = start.add(6, 'day').endOf('day');
  if (end.isBefore(start)) end = start.endOf('day');

  return {
    from: start.toISOString(),
    to: end.toISOString(),
    label: `${start.format('DD/MM')} – ${end.format('DD/MM')}`,
  };
}

/**
 * Painel de presença: confirmados / pendentes / faltas (declined) da semana.
 * Fonte: appointment_reminders (lembrete enviado + resposta SIM/NÃO).
 */
router.get('/presence', async (req: Request, res: Response) => {
  const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
  if (!auth.ok) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('subscription_tier, has_paid, multi_barber_plan, reminders_enabled')
    .eq('id', auth.user.id)
    .maybeSingle();

  const tier = profileSubscriptionTier(profile);
  if (!tierSupportsReminders(tier)) {
    return res.status(403).json({
      error: 'upgrade_required',
      message: 'Painel de presença disponível nos planos com lembretes (Pro / Pro+ / Agenda Web).',
    });
  }

  const range = weekRangeFromQuery(req);

  const { data, error } = await supabase
    .from('appointment_reminders')
    .select(
      'id, client_name, client_phone, barber_name, starts_at, sent_at, presence_status, presence_replied_at, google_event_id',
    )
    .eq('user_id', auth.user.id)
    .not('sent_at', 'is', null)
    .gte('starts_at', range.from)
    .lte('starts_at', range.to)
    .order('starts_at', { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const items = (data ?? []).map((row) => {
    const statusRaw = row.presence_status != null ? String(row.presence_status) : 'pending';
    const presence_status: PresenceStatus =
      statusRaw === 'confirmed' || statusRaw === 'declined' || statusRaw === 'pending'
        ? statusRaw
        : 'pending';
    return {
      id: String(row.id),
      client_name: row.client_name ? String(row.client_name) : null,
      client_phone: row.client_phone ? String(row.client_phone) : null,
      barber_name: row.barber_name ? String(row.barber_name) : null,
      starts_at: String(row.starts_at),
      sent_at: row.sent_at ? String(row.sent_at) : null,
      presence_status,
      presence_replied_at: row.presence_replied_at
        ? String(row.presence_replied_at)
        : null,
      google_event_id: row.google_event_id ? String(row.google_event_id) : null,
    };
  });

  const counts = {
    confirmed: items.filter((i) => i.presence_status === 'confirmed').length,
    pending: items.filter((i) => i.presence_status === 'pending').length,
    declined: items.filter((i) => i.presence_status === 'declined').length,
    total: items.length,
  };

  res.json({
    period: range,
    counts,
    items,
    reminders_enabled: Boolean(profile?.reminders_enabled),
  });
});

export default router;
