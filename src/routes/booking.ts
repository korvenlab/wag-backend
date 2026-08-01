import { Router, Request, Response } from 'express';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { supabase } from '../lib/supabase';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { profileSubscriptionTier } from '../lib/profileMultiBarber';
import { tierSupportsPublicBooking } from '../lib/wagooSubscription';
import { dayWindowsFromWorkingHours, BR_TZ } from '../lib/dateTimeBR';
import { slugifyStoreName } from '../lib/storeSlug';
import {
  bookingReminderEventId,
  cancelAppointmentReminder,
  notifyWebBookingCreated,
} from '../services/reminders';
import {
  checkAvailability,
  createEvent,
  deleteEvent,
  getCalendarEventById,
  listGoogleBusyRangesForDay,
} from '../services/calendar';
import { log } from '../lib/logger';

dayjs.extend(utc);
dayjs.extend(timezone);

const router = Router();

type BookingServiceRow = {
  id: string;
  profile_id: string;
  name: string;
  description: string;
  price_brl: number;
  duration_minutes: number;
  image_url: string | null;
  active: boolean;
  sort_order: number;
};

type PublishMissing = 'store_name' | 'services' | 'working_hours';

const MISSING_LABELS: Record<PublishMissing, string> = {
  store_name: 'Falta o nome do negócio',
  services: 'Falta adicionar pelo menos 1 serviço',
  working_hours:
    'Falta definir horário de funcionamento (ative manhã/tarde/noite em algum dia)',
};

function hoursHaveOpenWindow(hours: unknown): boolean {
  if (!hours || typeof hours !== 'object') return false;
  return Object.values(hours as Record<string, Record<string, unknown>>).some(
    (d) =>
      Boolean(d?.isTurno1Active) ||
      Boolean(d?.isTurno2Active) ||
      Boolean(d?.isTurno3Active),
  );
}

async function collectPublishMissing(
  userId: string,
  overrides: {
    store_name?: string;
    working_hours?: unknown;
  } = {},
): Promise<{ missing: PublishMissing[]; messages: string[] }> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('store_name, working_hours')
    .eq('id', userId)
    .maybeSingle();

  const { count: serviceCount } = await supabase
    .from('booking_services')
    .select('id', { count: 'exact', head: true })
    .eq('profile_id', userId)
    .eq('active', true);

  const storeName = String(overrides.store_name ?? profile?.store_name ?? '').trim();
  const hours = overrides.working_hours ?? profile?.working_hours;

  const missing: PublishMissing[] = [];
  if (storeName.length < 2) missing.push('store_name');
  if (!serviceCount || serviceCount < 1) missing.push('services');
  if (!hoursHaveOpenWindow(hours)) missing.push('working_hours');

  return {
    missing,
    messages: missing.map((m) => MISSING_LABELS[m]),
  };
}

function frontendBase(): string {
  return (process.env.FRONTEND_URL || 'https://wagoobot.com').replace(/\/$/, '');
}

function publicUrls(slug: string | null | undefined) {
  if (!slug) return { publicUrl: null, agendaUrl: null };
  return {
    publicUrl: `${frontendBase()}/a/${slug}`,
    agendaUrl: `${frontendBase()}/a/${slug}/agenda`,
  };
}

async function requireAgendaWebOwner(req: Request): Promise<
  | { ok: true; userId: string }
  | { ok: false; status: number; error: string }
> {
  const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
  if (!auth.ok) {
    return {
      ok: false,
      status: 401,
      error:
        auth.reason === 'missing_token'
          ? 'Faça login e envie Authorization: Bearer.'
          : 'Sessão inválida ou expirada.',
    };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('subscription_tier, has_paid, multi_barber_plan')
    .eq('id', auth.user.id)
    .maybeSingle();

  const tier = profileSubscriptionTier(profile);
  if (!tierSupportsPublicBooking(tier)) {
    return {
      ok: false,
      status: 403,
      error: 'Agenda Web disponível nos planos Agenda Web, Basic, Pro e Pro+.',
    };
  }

  return { ok: true, userId: auth.user.id };
}

async function bookingSlugTaken(slug: string, excludeUserId?: string): Promise<boolean> {
  let q = supabase.from('profiles').select('id').eq('booking_slug', slug);
  if (excludeUserId) q = q.neq('id', excludeUserId);
  const { data } = await q.maybeSingle();
  return Boolean(data);
}

async function resolveUniqueBookingSlug(
  storeName: string,
  excludeUserId?: string,
): Promise<string> {
  const base = slugifyStoreName(storeName);
  let candidate = base;
  let n = 2;
  while (await bookingSlugTaken(candidate, excludeUserId)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

function overlaps(
  aStart: dayjs.Dayjs,
  aEnd: dayjs.Dayjs,
  bStart: dayjs.Dayjs,
  bEnd: dayjs.Dayjs,
): boolean {
  return aStart.isBefore(bEnd) && aEnd.isAfter(bStart);
}

async function loadPublishedSite(slug: string) {
  const { data, error } = await supabase
    .from('profiles')
    .select(
      'id, store_name, booking_slug, booking_logo_url, booking_cover_url, booking_tagline, booking_phone, booking_address, booking_published, working_hours, subscription_tier',
    )
    .eq('booking_slug', slug)
    .maybeSingle();

  if (error || !data) return null;
  if (!data.booking_published) return null;
  if (!tierSupportsPublicBooking(profileSubscriptionTier(data))) return null;
  return data;
}

router.get('/me', async (req: Request, res: Response) => {
  const gate = await requireAgendaWebOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const { data: profile, error } = await supabase
    .from('profiles')
    .select(
      'store_name, booking_slug, booking_logo_url, booking_cover_url, booking_tagline, booking_phone, booking_address, booking_published, working_hours',
    )
    .eq('id', gate.userId)
    .maybeSingle();

  if (error || !profile) {
    return res.status(500).json({ error: error?.message || 'Perfil não encontrado.' });
  }

  const [{ data: services }, { data: providers }, { data: appointments }, publishCheck] =
    await Promise.all([
      supabase
        .from('booking_services')
        .select('*')
        .eq('profile_id', gate.userId)
        .order('sort_order', { ascending: true }),
      supabase
        .from('booking_providers')
        .select('*')
        .eq('profile_id', gate.userId)
        .order('sort_order', { ascending: true }),
      supabase
        .from('booking_appointments')
        .select(
          '*, booking_services(name, duration_minutes, price_brl), booking_providers(id, name)',
        )
        .eq('profile_id', gate.userId)
        .gte('starts_at', dayjs().subtract(1, 'day').toISOString())
        .order('starts_at', { ascending: true })
        .limit(50),
      collectPublishMissing(gate.userId, {
        store_name: profile.store_name ?? undefined,
        working_hours: profile.working_hours,
      }),
    ]);

  const urls = publicUrls(profile.booking_slug);

  res.json({
    profile,
    services: services ?? [],
    providers: providers ?? [],
    appointments: appointments ?? [],
    publicUrl: urls.publicUrl,
    agendaUrl: urls.agendaUrl,
    publishReady: publishCheck.missing.length === 0,
    missing: publishCheck.missing,
    missingMessages: publishCheck.messages,
  });
});

/** Diagnóstico: o evento existe de fato na Google Agenda da conta conectada? */
router.get('/google-check', async (req: Request, res: Response) => {
  const gate = await requireAgendaWebOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const { data: profile } = await supabase
    .from('profiles')
    .select('email, googleAuth')
    .eq('id', gate.userId)
    .maybeSingle();

  const ga = profile?.googleAuth as { refreshToken?: string | null } | null | undefined;
  const connected = Boolean(profile?.email && ga?.refreshToken);

  const { data: last } = await supabase
    .from('booking_appointments')
    .select('id, client_name, starts_at, ends_at, google_event_id, created_at')
    .eq('profile_id', gate.userId)
    .not('google_event_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let live: Awaited<ReturnType<typeof getCalendarEventById>> = null;
  if (connected && last?.google_event_id && profile?.email) {
    live = await getCalendarEventById(String(profile.email), String(last.google_event_id));
  }

  res.json({
    google_connected: connected,
    wagoo_email: profile?.email ?? null,
    last_synced_appointment: last
      ? {
          id: last.id,
          client_name: last.client_name,
          starts_at: last.starts_at,
          starts_at_br: dayjs(last.starts_at as string)
            .tz(BR_TZ)
            .format('DD/MM/YYYY HH:mm'),
          google_event_id: last.google_event_id,
        }
      : null,
    google_event_live: live,
    found_on_google: Boolean(live && live.status !== 'cancelled'),
    tip: live?.htmlLink
      ? 'Abra o link do evento na conta Google que autorizou o Wagoo.'
      : connected
        ? 'Confira o dia/horário do agendamento (pode não ser hoje) na agenda da conta conectada.'
        : 'Conecte a Google Agenda neste painel para sincronizar.',
  });
});

router.patch('/me', async (req: Request, res: Response) => {
  const gate = await requireAgendaWebOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const body = req.body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  if (typeof body.store_name === 'string') {
    const name = body.store_name.trim().slice(0, 80);
    if (name.length < 2) {
      return res.status(400).json({
        error: MISSING_LABELS.store_name,
        missing: ['store_name'] as PublishMissing[],
        missingMessages: [MISSING_LABELS.store_name],
      });
    }
    patch.store_name = name;
    patch.booking_slug = await resolveUniqueBookingSlug(name, gate.userId);
  }
  if (typeof body.booking_tagline === 'string') {
    patch.booking_tagline = body.booking_tagline.trim().slice(0, 120);
  }
  if (typeof body.booking_phone === 'string') {
    patch.booking_phone = body.booking_phone.trim().slice(0, 40);
  }
  if (typeof body.booking_address === 'string') {
    patch.booking_address = body.booking_address.trim().slice(0, 200);
  }
  if (typeof body.booking_logo_url === 'string') {
    patch.booking_logo_url = body.booking_logo_url.trim().slice(0, 500) || null;
  }
  if (typeof body.booking_cover_url === 'string') {
    patch.booking_cover_url = body.booking_cover_url.trim().slice(0, 500) || null;
  }
  if (typeof body.booking_published === 'boolean') {
    patch.booking_published = body.booking_published;
  }
  if (body.working_hours && typeof body.working_hours === 'object') {
    patch.working_hours = body.working_hours;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Nada para atualizar.' });
  }

  if (patch.booking_published === true) {
    const check = await collectPublishMissing(gate.userId, {
      store_name: typeof patch.store_name === 'string' ? patch.store_name : undefined,
      working_hours: patch.working_hours,
    });
    if (check.missing.length > 0) {
      return res.status(400).json({
        error: `Não deu para publicar. Ainda falta: ${check.messages.join('; ')}.`,
        missing: check.missing,
        missingMessages: check.messages,
      });
    }

    const { data: cur } = await supabase
      .from('profiles')
      .select('booking_slug, store_name')
      .eq('id', gate.userId)
      .maybeSingle();
    const slug = (patch.booking_slug as string) || cur?.booking_slug;
    if (!slug) {
      const name = String(patch.store_name || cur?.store_name || '').trim();
      patch.booking_slug = await resolveUniqueBookingSlug(name, gate.userId);
      if (!patch.store_name) patch.store_name = name;
    }
  }

  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', gate.userId)
    .select(
      'store_name, booking_slug, booking_logo_url, booking_cover_url, booking_tagline, booking_phone, booking_address, booking_published, working_hours',
    )
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });

  const urls = publicUrls(data?.booking_slug);
  const publishCheck = await collectPublishMissing(gate.userId, {
    store_name: data?.store_name ?? undefined,
    working_hours: data?.working_hours,
  });

  res.json({
    profile: data,
    publicUrl: urls.publicUrl,
    agendaUrl: urls.agendaUrl,
    publishReady: publishCheck.missing.length === 0,
    missing: publishCheck.missing,
    missingMessages: publishCheck.messages,
  });
});

router.post('/upload', async (req: Request, res: Response) => {
  const gate = await requireAgendaWebOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const dataUrl = typeof req.body?.dataUrl === 'string' ? req.body.dataUrl : '';
  const kindRaw = String(req.body?.kind || 'logo');
  const kind =
    kindRaw === 'service'
      ? 'service'
      : kindRaw === 'provider'
        ? 'provider'
        : kindRaw === 'cover'
          ? 'cover'
          : 'logo';
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) {
    return res.status(400).json({ error: 'Envie dataUrl de imagem PNG/JPEG/WebP.' });
  }

  const mime = match[1].toLowerCase().replace('jpg', 'jpeg');
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > 2.5 * 1024 * 1024) {
    return res.status(400).json({ error: 'Imagem deve ter no máximo 2,5 MB.' });
  }

  const path = `${gate.userId}/${kind}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('booking-assets').upload(path, buf, {
    contentType: mime,
    upsert: true,
  });
  if (error) return res.status(500).json({ error: error.message });

  const { data: pub } = supabase.storage.from('booking-assets').getPublicUrl(path);
  res.json({ url: pub.publicUrl });
});

/** ——— Providers (profissionais) ——— */

router.post('/providers', async (req: Request, res: Response) => {
  const gate = await requireAgendaWebOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const name = String(req.body?.name ?? '').trim().slice(0, 80);
  if (name.length < 2) return res.status(400).json({ error: 'Informe o nome do profissional.' });

  const bio = String(req.body?.bio ?? '').trim().slice(0, 300);
  const photoUrl =
    typeof req.body?.photo_url === 'string'
      ? req.body.photo_url.trim().slice(0, 500) || null
      : typeof req.body?.photoUrl === 'string'
        ? req.body.photoUrl.trim().slice(0, 500) || null
        : null;

  const { count } = await supabase
    .from('booking_providers')
    .select('id', { count: 'exact', head: true })
    .eq('profile_id', gate.userId);

  const { data, error } = await supabase
    .from('booking_providers')
    .insert({
      profile_id: gate.userId,
      name,
      bio,
      photo_url: photoUrl,
      sort_order: count ?? 0,
      active: true,
    })
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/providers/:id', async (req: Request, res: Response) => {
  const gate = await requireAgendaWebOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const id = String(req.params.id || '');
  const body = req.body as Record<string, unknown>;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body.name === 'string') {
    const name = body.name.trim().slice(0, 80);
    if (name.length < 2) return res.status(400).json({ error: 'Nome inválido.' });
    patch.name = name;
  }
  if (typeof body.bio === 'string') patch.bio = body.bio.trim().slice(0, 300);
  if (typeof body.photo_url === 'string' || typeof body.photoUrl === 'string') {
    const u = String(body.photo_url ?? body.photoUrl).trim().slice(0, 500);
    patch.photo_url = u || null;
  }
  if (typeof body.active === 'boolean') patch.active = body.active;
  if (typeof body.sort_order === 'number') patch.sort_order = body.sort_order;

  const { data, error } = await supabase
    .from('booking_providers')
    .update(patch)
    .eq('id', id)
    .eq('profile_id', gate.userId)
    .select('*')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Profissional não encontrado.' });
  res.json(data);
});

router.delete('/providers/:id', async (req: Request, res: Response) => {
  const gate = await requireAgendaWebOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const id = String(req.params.id || '');
  const { error } = await supabase
    .from('booking_providers')
    .delete()
    .eq('id', id)
    .eq('profile_id', gate.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post('/services', async (req: Request, res: Response) => {
  const gate = await requireAgendaWebOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const name = String(req.body?.name ?? '').trim().slice(0, 80);
  if (name.length < 2) return res.status(400).json({ error: 'Nome do serviço obrigatório.' });

  const description = String(req.body?.description ?? '').trim().slice(0, 300);
  const price = Number(req.body?.price_brl ?? req.body?.priceBrl ?? 0);
  const duration = Math.round(Number(req.body?.duration_minutes ?? req.body?.durationMinutes ?? 30));
  const imageUrl =
    typeof req.body?.image_url === 'string'
      ? req.body.image_url.trim().slice(0, 500) || null
      : typeof req.body?.imageUrl === 'string'
        ? req.body.imageUrl.trim().slice(0, 500) || null
        : null;

  if (!Number.isFinite(price) || price < 0) {
    return res.status(400).json({ error: 'Preço inválido.' });
  }
  if (!Number.isFinite(duration) || duration < 5 || duration > 480) {
    return res.status(400).json({ error: 'Duração inválida (5–480 min).' });
  }

  const { count } = await supabase
    .from('booking_services')
    .select('id', { count: 'exact', head: true })
    .eq('profile_id', gate.userId);

  const { data, error } = await supabase
    .from('booking_services')
    .insert({
      profile_id: gate.userId,
      name,
      description,
      price_brl: Math.round(price * 100) / 100,
      duration_minutes: duration,
      image_url: imageUrl,
      sort_order: count ?? 0,
      active: true,
    })
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/services/:id', async (req: Request, res: Response) => {
  const gate = await requireAgendaWebOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const id = String(req.params.id || '');
  const body = req.body as Record<string, unknown>;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body.name === 'string') {
    const name = body.name.trim().slice(0, 80);
    if (name.length < 2) return res.status(400).json({ error: 'Nome inválido.' });
    patch.name = name;
  }
  if (typeof body.description === 'string') patch.description = body.description.trim().slice(0, 300);
  if (body.price_brl != null || body.priceBrl != null) {
    const price = Number(body.price_brl ?? body.priceBrl);
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Preço inválido.' });
    patch.price_brl = Math.round(price * 100) / 100;
  }
  if (body.duration_minutes != null || body.durationMinutes != null) {
    const duration = Math.round(Number(body.duration_minutes ?? body.durationMinutes));
    if (!Number.isFinite(duration) || duration < 5 || duration > 480) {
      return res.status(400).json({ error: 'Duração inválida.' });
    }
    patch.duration_minutes = duration;
  }
  if (typeof body.image_url === 'string' || typeof body.imageUrl === 'string') {
    const u = String(body.image_url ?? body.imageUrl).trim().slice(0, 500);
    patch.image_url = u || null;
  }
  if (typeof body.active === 'boolean') patch.active = body.active;
  if (typeof body.sort_order === 'number') patch.sort_order = body.sort_order;

  const { data, error } = await supabase
    .from('booking_services')
    .update(patch)
    .eq('id', id)
    .eq('profile_id', gate.userId)
    .select('*')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Serviço não encontrado.' });
  res.json(data);
});

router.delete('/services/:id', async (req: Request, res: Response) => {
  const gate = await requireAgendaWebOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const id = String(req.params.id || '');
  const { error } = await supabase
    .from('booking_services')
    .delete()
    .eq('id', id)
    .eq('profile_id', gate.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.patch('/appointments/:id', async (req: Request, res: Response) => {
  const gate = await requireAgendaWebOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const status = String(req.body?.status || '');
  if (!['confirmed', 'cancelled', 'completed'].includes(status)) {
    return res.status(400).json({ error: 'Status inválido.' });
  }

  const { data, error } = await supabase
    .from('booking_appointments')
    .update({ status })
    .eq('id', String(req.params.id || ''))
    .eq('profile_id', gate.userId)
    .select('id, status, google_event_id')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Agendamento não encontrado.' });

  if (status === 'cancelled') {
    void cancelAppointmentReminder(gate.userId, bookingReminderEventId(String(data.id)));
    const eventId = data.google_event_id ? String(data.google_event_id) : '';
    if (eventId) {
      const { data: owner } = await supabase
        .from('profiles')
        .select('email')
        .eq('id', gate.userId)
        .maybeSingle();
      if (owner?.email) {
        void deleteEvent(String(owner.email), eventId);
      }
    }
  }

  res.json(data);
});

router.get('/public/:slug', async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const site = await loadPublishedSite(slug);
  if (!site) return res.status(404).json({ error: 'Agenda não encontrada ou não publicada.' });

  const [{ data: services }, { data: providers }] = await Promise.all([
    supabase
      .from('booking_services')
      .select('id, name, description, price_brl, duration_minutes, image_url')
      .eq('profile_id', site.id)
      .eq('active', true)
      .order('sort_order', { ascending: true }),
    supabase
      .from('booking_providers')
      .select('id, name, photo_url, bio')
      .eq('profile_id', site.id)
      .eq('active', true)
      .order('sort_order', { ascending: true }),
  ]);

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    store_name: site.store_name || 'Negócio',
    slug: site.booking_slug,
    logo_url: site.booking_logo_url,
    cover_url: site.booking_cover_url ?? null,
    tagline: site.booking_tagline || 'Agende online',
    phone: site.booking_phone,
    address: site.booking_address,
    working_hours: site.working_hours ?? null,
    services: services ?? [],
    providers: providers ?? [],
  });
});

/** Vista pública: dias ocupados / livres (somente booking_appointments). */
router.get('/public/:slug/calendar', async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const site = await loadPublishedSite(slug);
  if (!site) return res.status(404).json({ error: 'Agenda não encontrada.' });

  const from = String(req.query.from || dayjs().tz(BR_TZ).format('YYYY-MM-DD'));
  const to = String(req.query.to || dayjs().tz(BR_TZ).add(30, 'day').format('YYYY-MM-DD'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'Use from= e to= no formato YYYY-MM-DD.' });
  }

  const rangeStart = dayjs.tz(`${from}T00:00:00`, BR_TZ);
  const rangeEnd = dayjs.tz(`${to}T23:59:59`, BR_TZ);

  const { data: busy } = await supabase
    .from('booking_appointments')
    .select(
      'id, starts_at, ends_at, status, booking_services(name), booking_providers(name)',
    )
    .eq('profile_id', site.id)
    .eq('status', 'confirmed')
    .gte('starts_at', rangeStart.toISOString())
    .lte('starts_at', rangeEnd.toISOString())
    .order('starts_at', { ascending: true });

  const days: Record<
    string,
    { date: string; open: boolean; bookedCount: number; appointments: unknown[] }
  > = {};

  let cursor = rangeStart.startOf('day');
  const last = rangeEnd.startOf('day');
  while (cursor.isBefore(last) || cursor.isSame(last, 'day')) {
    const key = cursor.format('YYYY-MM-DD');
    const windows = dayWindowsFromWorkingHours(site.working_hours, key);
    days[key] = {
      date: key,
      open: windows.length > 0,
      bookedCount: 0,
      appointments: [],
    };
    cursor = cursor.add(1, 'day');
  }

  for (const row of busy ?? []) {
    const key = dayjs(row.starts_at).tz(BR_TZ).format('YYYY-MM-DD');
    if (!days[key]) continue;
    days[key].bookedCount += 1;
    days[key].appointments.push({
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      service: (row as { booking_services?: { name?: string } | null }).booking_services?.name,
      provider: (row as { booking_providers?: { name?: string } | null }).booking_providers?.name,
    });
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    store_name: site.store_name,
    slug: site.booking_slug,
    from,
    to,
    days: Object.values(days),
  });
});

router.get('/public/:slug/slots', async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const site = await loadPublishedSite(slug);
  if (!site) return res.status(404).json({ error: 'Agenda não encontrada.' });

  const rawIds = String(req.query.serviceIds || req.query.service_ids || '');
  const singleId = String(req.query.serviceId || req.query.service_id || '');
  const serviceIds = [
    ...new Set(
      (rawIds ? rawIds.split(',') : singleId ? [singleId] : [])
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const providerId = String(req.query.providerId || req.query.provider_id || '').trim();
  const day = String(req.query.day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return res.status(400).json({ error: 'Informe day=YYYY-MM-DD.' });
  }
  if (!serviceIds.length) return res.status(400).json({ error: 'Informe serviceId ou serviceIds.' });

  const { data: services } = await supabase
    .from('booking_services')
    .select('*')
    .in('id', serviceIds)
    .eq('profile_id', site.id)
    .eq('active', true);

  if (!services?.length || services.length !== serviceIds.length) {
    return res.status(404).json({ error: 'Serviço não encontrado.' });
  }

  if (providerId) {
    const { data: provider } = await supabase
      .from('booking_providers')
      .select('id')
      .eq('id', providerId)
      .eq('profile_id', site.id)
      .eq('active', true)
      .maybeSingle();
    if (!provider) return res.status(404).json({ error: 'Profissional não encontrado.' });
  }

  const duration = services.reduce(
    (sum, s) => sum + Number((s as BookingServiceRow).duration_minutes || 0),
    0,
  );
  const windows = dayWindowsFromWorkingHours(site.working_hours, day);
  if (!windows.length) return res.json({ slots: [], duration_minutes: duration });

  const dayStart = dayjs.tz(`${day}T00:00:00`, BR_TZ);
  const dayEnd = dayStart.add(1, 'day');
  const now = dayjs().tz(BR_TZ);

  let busyQuery = supabase
    .from('booking_appointments')
    .select('starts_at, ends_at, provider_id')
    .eq('profile_id', site.id)
    .eq('status', 'confirmed')
    .lt('starts_at', dayEnd.toISOString())
    .gt('ends_at', dayStart.toISOString());

  if (providerId) {
    busyQuery = busyQuery.or(`provider_id.eq.${providerId},provider_id.is.null`);
  }

  const { data: busy } = await busyQuery;

  const busyRanges = (busy ?? []).map((b) => ({
    start: dayjs(b.starts_at).tz(BR_TZ),
    end: dayjs(b.ends_at).tz(BR_TZ),
  }));

  // Se o dono conectou Google Calendar, respeita também o free/busy da agenda dele.
  const { data: ownerCal } = await supabase
    .from('profiles')
    .select('email, googleAuth')
    .eq('id', site.id)
    .maybeSingle();

  if (ownerCal?.email && ownerCal.googleAuth) {
    const ga = ownerCal.googleAuth as { refreshToken?: string | null };
    if (ga.refreshToken) {
      const gBusy = await listGoogleBusyRangesForDay(String(ownerCal.email), day);
      for (const g of gBusy) {
        busyRanges.push({
          start: dayjs(g.startIso).tz(BR_TZ),
          end: dayjs(g.endIso).tz(BR_TZ),
        });
      }
    }
  }

  // Grade fixa de 15 min (como barbearias típicas); duração do bloco = soma dos serviços.
  const STEP = 15;
  const slots: string[] = [];
  for (const w of windows) {
    let cursor = dayjs.tz(`${day}T${w.startHm}:00`, BR_TZ);
    const end = dayjs.tz(`${day}T${w.endHm}:00`, BR_TZ);
    while (cursor.add(duration, 'minute').isSame(end) || cursor.add(duration, 'minute').isBefore(end)) {
      const slotEnd = cursor.add(duration, 'minute');
      if (cursor.isAfter(now.add(10, 'minute'))) {
        const conflict = busyRanges.some((b) => overlaps(cursor, slotEnd, b.start, b.end));
        if (!conflict) slots.push(cursor.toISOString());
      }
      cursor = cursor.add(STEP, 'minute');
      if (slots.length >= 64) break;
    }
    if (slots.length >= 64) break;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json({ slots, duration_minutes: duration });
});

router.post('/public/:slug/appointments', async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const site = await loadPublishedSite(slug);
  if (!site) return res.status(404).json({ error: 'Agenda não encontrada.' });

  const bodyIds = Array.isArray(req.body?.serviceIds)
    ? (req.body.serviceIds as unknown[]).map((x) => String(x))
    : Array.isArray(req.body?.service_ids)
      ? (req.body.service_ids as unknown[]).map((x) => String(x))
      : [];
  const singleId = String(req.body?.serviceId ?? req.body?.service_id ?? '');
  const serviceIds = [...new Set((bodyIds.length ? bodyIds : singleId ? [singleId] : []).filter(Boolean))];

  const providerIdRaw = String(req.body?.providerId ?? req.body?.provider_id ?? '').trim();
  const providerId = providerIdRaw || null;
  const clientName = String(req.body?.clientName ?? req.body?.client_name ?? '').trim().slice(0, 80);
  const clientPhone = String(req.body?.clientPhone ?? req.body?.client_phone ?? '')
    .replace(/\D/g, '')
    .slice(0, 20);
  const startsAtRaw = String(req.body?.startsAt ?? req.body?.starts_at ?? '');

  if (!serviceIds.length) return res.status(400).json({ error: 'Selecione pelo menos um serviço.' });
  if (clientName.length < 2) return res.status(400).json({ error: 'Informe o nome.' });
  if (clientPhone.length < 10) return res.status(400).json({ error: 'Informe um WhatsApp válido.' });

  const startsAt = dayjs(startsAtRaw);
  if (!startsAt.isValid()) return res.status(400).json({ error: 'Horário inválido.' });
  if (startsAt.isBefore(dayjs().add(10, 'minute'))) {
    return res.status(400).json({ error: 'Escolha um horário futuro.' });
  }

  const { data: services } = await supabase
    .from('booking_services')
    .select('*')
    .in('id', serviceIds)
    .eq('profile_id', site.id)
    .eq('active', true);

  if (!services?.length || services.length !== serviceIds.length) {
    return res.status(404).json({ error: 'Serviço não encontrado.' });
  }

  let providerName: string | null = null;
  if (providerId) {
    const { data: provider } = await supabase
      .from('booking_providers')
      .select('id, name')
      .eq('id', providerId)
      .eq('profile_id', site.id)
      .eq('active', true)
      .maybeSingle();
    if (!provider) return res.status(404).json({ error: 'Profissional não encontrado.' });
    providerName = provider.name;
  }

  const duration = services.reduce(
    (sum, s) => sum + Number((s as BookingServiceRow).duration_minutes || 0),
    0,
  );
  const totalPrice = services.reduce(
    (sum, s) => sum + Number((s as BookingServiceRow).price_brl || 0),
    0,
  );
  const serviceNames = services.map((s) => (s as BookingServiceRow).name).join(', ');
  const primary = services[0] as BookingServiceRow;
  const endsAt = startsAt.add(duration, 'minute');
  const day = startsAt.tz(BR_TZ).format('YYYY-MM-DD');
  const windows = dayWindowsFromWorkingHours(site.working_hours, day);
  const inWindow = windows.some((w) => {
    const ws = dayjs.tz(`${day}T${w.startHm}:00`, BR_TZ);
    const we = dayjs.tz(`${day}T${w.endHm}:00`, BR_TZ);
    return (
      (startsAt.isSame(ws) || startsAt.isAfter(ws)) &&
      (endsAt.isSame(we) || endsAt.isBefore(we))
    );
  });
  if (!inWindow) return res.status(400).json({ error: 'Horário fora do funcionamento.' });

  let busyQuery = supabase
    .from('booking_appointments')
    .select('starts_at, ends_at')
    .eq('profile_id', site.id)
    .eq('status', 'confirmed')
    .lt('starts_at', endsAt.toISOString())
    .gt('ends_at', startsAt.toISOString());

  if (providerId) {
    busyQuery = busyQuery.or(`provider_id.eq.${providerId},provider_id.is.null`);
  }

  const { data: busy } = await busyQuery;
  if ((busy ?? []).length > 0) {
    return res.status(409).json({ error: 'Horário acabou de ser preenchido. Escolha outro.' });
  }

  const { data: ownerCal } = await supabase
    .from('profiles')
    .select('email, googleAuth')
    .eq('id', site.id)
    .maybeSingle();

  const googleAuth = ownerCal?.googleAuth as { refreshToken?: string | null } | null | undefined;
  const canSyncGoogle = Boolean(ownerCal?.email && googleAuth?.refreshToken);

  if (canSyncGoogle) {
    const freeOnGoogle = await checkAvailability(
      String(ownerCal!.email),
      startsAt.toISOString(),
      duration,
    );
    if (!freeOnGoogle) {
      return res.status(409).json({
        error: 'Horário ocupado na Google Agenda. Escolha outro.',
      });
    }
  }

  const { data, error } = await supabase
    .from('booking_appointments')
    .insert({
      profile_id: site.id,
      service_id: primary.id,
      provider_id: providerId,
      client_name: clientName,
      client_phone: clientPhone,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      status: 'confirmed',
      notes:
        services.length > 1
          ? `Serviços: ${serviceNames}`
          : '',
    })
    .select('id, starts_at, ends_at, client_name, status, provider_id')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  let googleEventId: string | null = null;
  if (canSyncGoogle) {
    try {
      const created = await createEvent(
        String(ownerCal!.email),
        clientName,
        clientPhone,
        startsAt.toISOString(),
        duration,
        {
          barberName: providerName || undefined,
          serviceNames,
          source: 'agenda_web',
        },
      );
      if (created?.id) {
        googleEventId = created.id;
        const { error: upErr } = await supabase
          .from('booking_appointments')
          .update({ google_event_id: created.id })
          .eq('id', data.id);
        if (upErr) {
          log.error('BOOKING', 'falha ao gravar google_event_id', upErr, {
            appointmentId: data.id,
          });
        } else {
          log.info('BOOKING', 'evento Google criado', {
            appointmentId: data.id,
            googleEventId: created.id,
          });
        }
      } else {
        log.warn('BOOKING', 'createEvent retornou null — Google não sincronizou', {
          appointmentId: data.id,
          email: ownerCal?.email,
        });
      }
    } catch (err) {
      log.error('BOOKING', 'falha ao criar evento Google', err, {
        appointmentId: data.id,
      });
    }
  }

  void notifyWebBookingCreated({
    ownerUserId: site.id as string,
    appointmentId: data.id as string,
    clientName,
    clientPhone,
    startsAtIso: data.starts_at as string,
    storeName: String(site.store_name || 'Negócio'),
    serviceNames,
    providerName,
  });

  res.status(201).json({
    appointment: { ...data, google_event_id: googleEventId },
    service: {
      name: serviceNames,
      price_brl: Math.round(totalPrice * 100) / 100,
      duration_minutes: duration,
    },
    services: services.map((s) => ({
      id: (s as BookingServiceRow).id,
      name: (s as BookingServiceRow).name,
      price_brl: (s as BookingServiceRow).price_brl,
      duration_minutes: (s as BookingServiceRow).duration_minutes,
    })),
    provider: providerName ? { id: providerId, name: providerName } : null,
    store_name: site.store_name,
    google_synced: Boolean(googleEventId),
  });
});

router.get('/public/:slug/my', async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const site = await loadPublishedSite(slug);
  if (!site) return res.status(404).json({ error: 'Agenda não encontrada.' });

  const phone = String(req.query.phone || '').replace(/\D/g, '');
  if (phone.length < 10) return res.status(400).json({ error: 'Informe o telefone.' });

  const { data } = await supabase
    .from('booking_appointments')
    .select(
      'id, starts_at, ends_at, status, client_name, notes, booking_services(name, price_brl, duration_minutes), booking_providers(name)',
    )
    .eq('profile_id', site.id)
    .eq('client_phone', phone)
    .neq('status', 'cancelled')
    .gte('starts_at', dayjs().subtract(1, 'day').toISOString())
    .order('starts_at', { ascending: true })
    .limit(20);

  res.json({ appointments: data ?? [] });
});

export default router;
