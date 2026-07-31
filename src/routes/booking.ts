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
      error: 'Este recurso é exclusivo do plano Agenda Web.',
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
      'id, store_name, booking_slug, booking_logo_url, booking_tagline, booking_phone, booking_address, booking_published, working_hours, subscription_tier',
    )
    .eq('booking_slug', slug)
    .maybeSingle();

  if (error || !data) return null;
  if (!data.booking_published) return null;
  if (!tierSupportsPublicBooking(profileSubscriptionTier(data))) return null;
  return data;
}

/** Config + serviços + próximos agendamentos (dono). */
router.get('/me', async (req: Request, res: Response) => {
  const gate = await requireAgendaWebOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const { data: profile, error } = await supabase
    .from('profiles')
    .select(
      'store_name, booking_slug, booking_logo_url, booking_tagline, booking_phone, booking_address, booking_published, working_hours',
    )
    .eq('id', gate.userId)
    .maybeSingle();

  if (error || !profile) {
    return res.status(500).json({ error: error?.message || 'Perfil não encontrado.' });
  }

  const { data: services } = await supabase
    .from('booking_services')
    .select('*')
    .eq('profile_id', gate.userId)
    .order('sort_order', { ascending: true });

  const { data: appointments } = await supabase
    .from('booking_appointments')
    .select('*, booking_services(name, duration_minutes, price_brl)')
    .eq('profile_id', gate.userId)
    .gte('starts_at', dayjs().subtract(1, 'day').toISOString())
    .order('starts_at', { ascending: true })
    .limit(50);

  const frontend = (process.env.FRONTEND_URL || 'https://wagoobot.com').replace(/\/$/, '');
  const publicUrl = profile.booking_slug ? `${frontend}/a/${profile.booking_slug}` : null;

  res.json({
    profile,
    services: services ?? [],
    appointments: appointments ?? [],
    publicUrl,
  });
});

/** Atualiza dados da vitrine / slug. */
router.patch('/me', async (req: Request, res: Response) => {
  const gate = await requireAgendaWebOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const body = req.body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  if (typeof body.store_name === 'string') {
    const name = body.store_name.trim().slice(0, 80);
    if (name.length < 2) return res.status(400).json({ error: 'Nome da barbearia inválido.' });
    patch.store_name = name;
    const slug = await resolveUniqueBookingSlug(name, gate.userId);
    patch.booking_slug = slug;
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
  if (typeof body.booking_published === 'boolean') {
    patch.booking_published = body.booking_published;
  }
  if (body.working_hours && typeof body.working_hours === 'object') {
    patch.working_hours = body.working_hours;
  }

  // Horário padrão se ainda não configurado (necessário para gerar slots).
  if (patch.booking_published === true || patch.store_name) {
    const { data: curWh } = await supabase
      .from('profiles')
      .select('working_hours')
      .eq('id', gate.userId)
      .maybeSingle();
    const wh = curWh?.working_hours;
    const empty =
      !wh ||
      typeof wh !== 'object' ||
      Object.keys(wh as object).length === 0;
    if (empty && !patch.working_hours) {
      const day = {
        startTime: '09:00',
        endTime: '12:00',
        isTurno1Active: true,
        startTime2: '14:00',
        endTime2: '19:00',
        isTurno2Active: true,
        startTime3: '19:00',
        endTime3: '22:00',
        isTurno3Active: false,
      };
      patch.working_hours = {
        'Segunda-feira': { ...day },
        'Terça-feira': { ...day },
        'Quarta-feira': { ...day },
        'Quinta-feira': { ...day },
        'Sexta-feira': { ...day },
        Sábado: {
          ...day,
          endTime2: '18:00',
          isTurno2Active: true,
        },
        Domingo: { ...day, isTurno1Active: false, isTurno2Active: false },
      };
    }
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Nada para atualizar.' });
  }

  if (patch.booking_published === true) {
    const { data: cur } = await supabase
      .from('profiles')
      .select('booking_slug, store_name')
      .eq('id', gate.userId)
      .maybeSingle();
    const slug = (patch.booking_slug as string) || cur?.booking_slug;
    if (!slug) {
      const name = String(patch.store_name || cur?.store_name || '').trim();
      if (name.length < 2) {
        return res.status(400).json({ error: 'Defina o nome da barbearia antes de publicar.' });
      }
      patch.booking_slug = await resolveUniqueBookingSlug(name, gate.userId);
      if (!patch.store_name) patch.store_name = name;
    }
  }

  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', gate.userId)
    .select(
      'store_name, booking_slug, booking_logo_url, booking_tagline, booking_phone, booking_address, booking_published, working_hours',
    )
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });

  const frontend = (process.env.FRONTEND_URL || 'https://wagoobot.com').replace(/\/$/, '');
  res.json({
    profile: data,
    publicUrl: data?.booking_slug ? `${frontend}/a/${data.booking_slug}` : null,
  });
});

/** Upload de imagem (logo ou serviço) via data URL → Storage. */
router.post('/upload', async (req: Request, res: Response) => {
  const gate = await requireAgendaWebOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const dataUrl = typeof req.body?.dataUrl === 'string' ? req.body.dataUrl : '';
  const kind = req.body?.kind === 'service' ? 'service' : 'logo';
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
    .select('*')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Agendamento não encontrado.' });
  res.json(data);
});

/** ——— Público ——— */

router.get('/public/:slug', async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const site = await loadPublishedSite(slug);
  if (!site) return res.status(404).json({ error: 'Agenda não encontrada ou não publicada.' });

  const { data: services } = await supabase
    .from('booking_services')
    .select('id, name, description, price_brl, duration_minutes, image_url')
    .eq('profile_id', site.id)
    .eq('active', true)
    .order('sort_order', { ascending: true });

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    store_name: site.store_name || 'Barbearia',
    slug: site.booking_slug,
    logo_url: site.booking_logo_url,
    tagline: site.booking_tagline || 'Agende online',
    phone: site.booking_phone,
    address: site.booking_address,
    services: services ?? [],
  });
});

router.get('/public/:slug/slots', async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const site = await loadPublishedSite(slug);
  if (!site) return res.status(404).json({ error: 'Agenda não encontrada.' });

  const serviceId = String(req.query.serviceId || req.query.service_id || '');
  const day = String(req.query.day || ''); // YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return res.status(400).json({ error: 'Informe day=YYYY-MM-DD.' });
  }

  const { data: service } = await supabase
    .from('booking_services')
    .select('*')
    .eq('id', serviceId)
    .eq('profile_id', site.id)
    .eq('active', true)
    .maybeSingle();

  if (!service) return res.status(404).json({ error: 'Serviço não encontrado.' });

  const duration = (service as BookingServiceRow).duration_minutes;
  const windows = dayWindowsFromWorkingHours(site.working_hours, day);
  if (!windows.length) return res.json({ slots: [] });

  const dayStart = dayjs.tz(`${day}T00:00:00`, BR_TZ);
  const dayEnd = dayStart.add(1, 'day');
  const now = dayjs().tz(BR_TZ);

  const { data: busy } = await supabase
    .from('booking_appointments')
    .select('starts_at, ends_at')
    .eq('profile_id', site.id)
    .eq('status', 'confirmed')
    .lt('starts_at', dayEnd.toISOString())
    .gt('ends_at', dayStart.toISOString());

  const busyRanges = (busy ?? []).map((b) => ({
    start: dayjs(b.starts_at).tz(BR_TZ),
    end: dayjs(b.ends_at).tz(BR_TZ),
  }));

  const slots: string[] = [];
  for (const w of windows) {
    let cursor = dayjs.tz(`${day}T${w.startHm}:00`, BR_TZ);
    const end = dayjs.tz(`${day}T${w.endHm}:00`, BR_TZ);
    while (cursor.add(duration, 'minute').isSame(end) || cursor.add(duration, 'minute').isBefore(end)) {
      const slotEnd = cursor.add(duration, 'minute');
      if (cursor.isAfter(now.add(15, 'minute'))) {
        const conflict = busyRanges.some((b) => overlaps(cursor, slotEnd, b.start, b.end));
        if (!conflict) slots.push(cursor.toISOString());
      }
      cursor = cursor.add(duration, 'minute');
      if (slots.length >= 48) break;
    }
    if (slots.length >= 48) break;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json({ slots, duration_minutes: duration });
});

router.post('/public/:slug/appointments', async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const site = await loadPublishedSite(slug);
  if (!site) return res.status(404).json({ error: 'Agenda não encontrada.' });

  const serviceId = String(req.body?.serviceId ?? req.body?.service_id ?? '');
  const clientName = String(req.body?.clientName ?? req.body?.client_name ?? '').trim().slice(0, 80);
  const clientPhone = String(req.body?.clientPhone ?? req.body?.client_phone ?? '')
    .replace(/\D/g, '')
    .slice(0, 20);
  const startsAtRaw = String(req.body?.startsAt ?? req.body?.starts_at ?? '');

  if (clientName.length < 2) return res.status(400).json({ error: 'Informe o nome.' });
  if (clientPhone.length < 10) return res.status(400).json({ error: 'Informe um WhatsApp válido.' });

  const startsAt = dayjs(startsAtRaw);
  if (!startsAt.isValid()) return res.status(400).json({ error: 'Horário inválido.' });
  if (startsAt.isBefore(dayjs().add(10, 'minute'))) {
    return res.status(400).json({ error: 'Escolha um horário futuro.' });
  }

  const { data: service } = await supabase
    .from('booking_services')
    .select('*')
    .eq('id', serviceId)
    .eq('profile_id', site.id)
    .eq('active', true)
    .maybeSingle();

  if (!service) return res.status(404).json({ error: 'Serviço não encontrado.' });

  const duration = (service as BookingServiceRow).duration_minutes;
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

  const { data: busy } = await supabase
    .from('booking_appointments')
    .select('starts_at, ends_at')
    .eq('profile_id', site.id)
    .eq('status', 'confirmed')
    .lt('starts_at', endsAt.toISOString())
    .gt('ends_at', startsAt.toISOString());

  if ((busy ?? []).length > 0) {
    return res.status(409).json({ error: 'Horário acabou de ser preenchido. Escolha outro.' });
  }

  const { data, error } = await supabase
    .from('booking_appointments')
    .insert({
      profile_id: site.id,
      service_id: serviceId,
      client_name: clientName,
      client_phone: clientPhone,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      status: 'confirmed',
    })
    .select('id, starts_at, ends_at, client_name, status')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.status(201).json({
    appointment: data,
    service: {
      name: (service as BookingServiceRow).name,
      price_brl: (service as BookingServiceRow).price_brl,
      duration_minutes: duration,
    },
    store_name: site.store_name,
  });
});

/** Consulta agendamentos do cliente por telefone. */
router.get('/public/:slug/my', async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const site = await loadPublishedSite(slug);
  if (!site) return res.status(404).json({ error: 'Agenda não encontrada.' });

  const phone = String(req.query.phone || '').replace(/\D/g, '');
  if (phone.length < 10) return res.status(400).json({ error: 'Informe o telefone.' });

  const { data } = await supabase
    .from('booking_appointments')
    .select('id, starts_at, ends_at, status, client_name, booking_services(name, price_brl, duration_minutes)')
    .eq('profile_id', site.id)
    .eq('client_phone', phone)
    .neq('status', 'cancelled')
    .gte('starts_at', dayjs().subtract(1, 'day').toISOString())
    .order('starts_at', { ascending: true })
    .limit(20);

  res.json({ appointments: data ?? [] });
});

export default router;
