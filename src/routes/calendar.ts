import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { profileHasWagooAccess } from '../lib/profileAccess';
import { profileSubscriptionTier } from '../lib/profileMultiBarber';
import { listAllBarbeirosForUser } from '../lib/barbeiros';
import { syncCalendarShareSlug } from '../lib/storeSlug';
import { tierSupportsAnalytics } from '../lib/wagooSubscription';
import {
  eventsToCsvWithCommission,
  type PaidAppointmentForExport,
} from '../lib/csvCommissionExport';
import { listCalendarEvents, type CalendarEventDto } from '../services/calendar';

const router = Router();

function frontendBaseUrl(): string {
  return (process.env.FRONTEND_URL?.trim() || 'http://localhost:5173').replace(/\/$/, '');
}

function publicShareUrl(slug: string): string {
  return `${frontendBaseUrl()}/calendario/publico/${encodeURIComponent(slug)}`;
}

function filterEventsByBarber(
  events: CalendarEventDto[],
  barberFilter: string,
  barberNames: string[],
): CalendarEventDto[] {
  if (!barberFilter || barberFilter === 'all') return events;

  const target = barberNames.find((n) => n.toLowerCase() === barberFilter.toLowerCase());
  if (!target) return events;

  return events.filter((ev) => {
    if (ev.source === 'wagoo' && ev.barberName) {
      return ev.barberName.trim().toLowerCase() === target.toLowerCase();
    }
    return false;
  });
}

async function loadPaidAppointmentsForExport(
  profileId: string,
  from: string,
  to: string,
): Promise<PaidAppointmentForExport[]> {
  const { data, error } = await supabase
    .from('booking_appointments')
    .select(
      'id, google_event_id, client_name, client_phone, starts_at, ends_at, price_brl, deposit_amount_brl, application_fee_brl, payment_status, notes, booking_providers(name)',
    )
    .eq('profile_id', profileId)
    .eq('payment_status', 'paid')
    .gte('starts_at', from)
    .lte('starts_at', to)
    .order('starts_at', { ascending: true });

  if (error) {
    console.error('[calendar/export] paid appointments:', error.message);
    return [];
  }

  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const provider = r.booking_providers as { name?: string } | null | undefined;
    return {
      id: String(r.id),
      google_event_id: r.google_event_id ? String(r.google_event_id) : null,
      client_name: String(r.client_name ?? ''),
      client_phone: String(r.client_phone ?? ''),
      starts_at: String(r.starts_at),
      ends_at: String(r.ends_at),
      price_brl: Number(r.price_brl) || 0,
      deposit_amount_brl:
        (r as { deposit_amount_brl?: unknown }).deposit_amount_brl != null
          ? Number((r as { deposit_amount_brl: unknown }).deposit_amount_brl)
          : null,
      application_fee_brl:
        (r as { application_fee_brl?: unknown }).application_fee_brl != null
          ? Number((r as { application_fee_brl: unknown }).application_fee_brl)
          : null,
      payment_status: String(r.payment_status ?? 'paid'),
      notes: r.notes != null ? String(r.notes) : null,
      provider_name: provider?.name ? String(provider.name) : null,
    };
  });
}

async function loadProfileForOwner(userId: string) {
  return supabase
    .from('profiles')
    .select(
      'id, email, store_name, has_paid, complimentary_access_until, googleAuth, calendar_share_token, subscription_tier, multi_barber_plan',
    )
    .eq('id', userId)
    .maybeSingle();
}

router.get('/events', async (req: Request, res: Response) => {
  try {
    const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
    if (!auth.ok) {
      return res.status(401).json({
        error:
          auth.reason === 'missing_token'
            ? 'Envie Authorization: Bearer com o access_token da sessão.'
            : 'Sessão inválida ou expirada.',
      });
    }

    const { data: profile, error } = await loadProfileForOwner(auth.user.id);
    if (error) return res.status(500).json({ error: error.message });
    if (!profile) return res.status(404).json({ error: 'Perfil não encontrado' });

    const row = profile as Record<string, unknown>;
    if (
      !profileHasWagooAccess({
        has_paid: row.has_paid,
        complimentary_access_until: row.complimentary_access_until,
      })
    ) {
      return res.status(403).json({ error: 'Assinatura activa necessária para ver o calendário.' });
    }

    const from = String(req.query.from ?? '').trim();
    const to = String(req.query.to ?? '').trim();
    if (!from || !to) {
      return res.status(400).json({ error: 'Parâmetros from e to (ISO) são obrigatórios.' });
    }

    const googleAuth = row.googleAuth as Record<string, unknown> | null | undefined;
    const googleConnected = Boolean(googleAuth?.refreshToken);

    const barbeiros = await listAllBarbeirosForUser(auth.user.id);
    const barberNames = barbeiros.map((b) => b.nome);
    const barberFilter = String(req.query.barber ?? 'all').trim();

    if (!googleConnected) {
      return res.json({
        events: [],
        googleConnected: false,
        barbeiros: barbeiros.map((b) => ({ id: b.id, nome: b.nome, ativo: b.ativo })),
        store_name: profile.store_name ?? null,
      });
    }

    const email = String(profile.email).toLowerCase().trim();
    let events = await listCalendarEvents(email, from, to);
    events = filterEventsByBarber(events, barberFilter, barberNames);

    res.json({
      events,
      googleConnected: true,
      barbeiros: barbeiros.map((b) => ({ id: b.id, nome: b.nome, ativo: b.ativo })),
      store_name: profile.store_name ?? null,
    });
  } catch {
    res.status(500).json({ error: 'Erro ao carregar calendário.' });
  }
});

/** CSV de agendamentos — Pro / Pro+ (contabilidade / analytics). */
router.get('/events/export', async (req: Request, res: Response) => {
  try {
    const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
    if (!auth.ok) {
      return res.status(401).json({
        error:
          auth.reason === 'missing_token'
            ? 'Envie Authorization: Bearer com o access_token da sessão.'
            : 'Sessão inválida ou expirada.',
      });
    }

    const { data: profile, error } = await loadProfileForOwner(auth.user.id);
    if (error) return res.status(500).json({ error: error.message });
    if (!profile) return res.status(404).json({ error: 'Perfil não encontrado' });

    const row = profile as Record<string, unknown>;
    if (
      !profileHasWagooAccess({
        has_paid: row.has_paid,
        complimentary_access_until: row.complimentary_access_until,
      })
    ) {
      return res.status(403).json({ error: 'Assinatura activa necessária.' });
    }

    const tier = profileSubscriptionTier({
      subscription_tier: row.subscription_tier,
      has_paid: row.has_paid,
      multi_barber_plan: row.multi_barber_plan as boolean | null | undefined,
    });
    if (!tierSupportsAnalytics(tier)) {
      return res.status(403).json({
        error: 'Exportação CSV está disponível nos planos Pro e Pro+.',
      });
    }

    const from = String(req.query.from ?? '').trim();
    const to = String(req.query.to ?? '').trim();
    if (!from || !to) {
      return res.status(400).json({ error: 'Parâmetros from e to (ISO) são obrigatórios.' });
    }

    const googleAuth = row.googleAuth as Record<string, unknown> | null | undefined;
    if (!googleAuth?.refreshToken) {
      return res.status(400).json({
        error: 'Conecte o Google Agenda para exportar agendamentos.',
      });
    }

    const email = String(profile.email).toLowerCase().trim();
    const [events, barbeiros, paidAppointments] = await Promise.all([
      listCalendarEvents(email, from, to),
      listAllBarbeirosForUser(auth.user.id),
      loadPaidAppointmentsForExport(auth.user.id, from, to),
    ]);
    const csv = eventsToCsvWithCommission({
      events,
      paidAppointments,
      barbeiros,
    });
    const stamp = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="wagoo-agendamentos-${stamp}.csv"`,
    );
    res.send(`\uFEFF${csv}`);
  } catch {
    res.status(500).json({ error: 'Erro ao exportar agendamentos.' });
  }
});

router.get('/share', async (req: Request, res: Response) => {
  try {
    const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
    if (!auth.ok) {
      return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    }

    const { data: profile, error } = await loadProfileForOwner(auth.user.id);
    if (error) return res.status(500).json({ error: error.message });
    if (!profile) return res.status(404).json({ error: 'Perfil não encontrado' });

    const currentSlug = (profile as { calendar_share_token?: string | null }).calendar_share_token;
    const synced = await syncCalendarShareSlug(
      supabase,
      auth.user.id,
      profile.store_name,
      currentSlug,
    );

    if (!synced.slug) {
      return res.json({
        enabled: false,
        shareUrl: null,
        slug: null,
        store_name: profile.store_name ?? null,
        message: synced.error,
      });
    }

    res.json({
      enabled: true,
      slug: synced.slug,
      shareUrl: publicShareUrl(synced.slug),
      store_name: profile.store_name ?? null,
    });
  } catch {
    res.status(500).json({ error: 'Erro ao obter link de partilha.' });
  }
});

router.post('/share', async (req: Request, res: Response) => {
  try {
    const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
    if (!auth.ok) {
      return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    }

    const { data: profile, error } = await loadProfileForOwner(auth.user.id);
    if (error) return res.status(500).json({ error: error.message });
    if (!profile) return res.status(404).json({ error: 'Perfil não encontrado' });

    const row = profile as Record<string, unknown>;
    if (
      !profileHasWagooAccess({
        has_paid: row.has_paid,
        complimentary_access_until: row.complimentary_access_until,
      })
    ) {
      return res.status(403).json({ error: 'Assinatura activa necessária.' });
    }

    const currentSlug = (profile as { calendar_share_token?: string | null }).calendar_share_token;
    const synced = await syncCalendarShareSlug(
      supabase,
      auth.user.id,
      profile.store_name,
      currentSlug,
    );

    if (!synced.slug) {
      return res.status(400).json({ error: synced.error ?? 'Nome da loja obrigatório.' });
    }

    res.json({
      enabled: true,
      slug: synced.slug,
      shareUrl: publicShareUrl(synced.slug),
      store_name: profile.store_name ?? null,
    });
  } catch {
    res.status(500).json({ error: 'Erro ao activar partilha.' });
  }
});

router.delete('/share', async (req: Request, res: Response) => {
  try {
    const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
    if (!auth.ok) {
      return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    }

    const { error: upErr } = await supabase
      .from('profiles')
      .update({ calendar_share_token: null })
      .eq('id', auth.user.id);

    if (upErr) return res.status(500).json({ error: upErr.message });
    res.json({ enabled: false, shareUrl: null, slug: null });
  } catch {
    res.status(500).json({ error: 'Erro ao desactivar partilha.' });
  }
});

/** Visualização pública — slug = nome da loja (ex.: barbearia-do-joao). */
router.get('/public/:slug/events', async (req: Request, res: Response) => {
  try {
    const slug = decodeURIComponent(String(req.params.slug ?? '').trim()).toLowerCase();
    if (!slug) return res.status(400).json({ error: 'Link inválido.' });

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, email, store_name, googleAuth')
      .eq('calendar_share_token', slug)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!profile) {
      return res.status(404).json({
        error: 'Calendário não encontrado. Verifique o nome da loja ou se o link foi desactivado.',
      });
    }

    const from = String(req.query.from ?? '').trim();
    const to = String(req.query.to ?? '').trim();
    if (!from || !to) {
      return res.status(400).json({ error: 'Parâmetros from e to (ISO) são obrigatórios.' });
    }

    const googleAuth = (profile as Record<string, unknown>).googleAuth as
      | Record<string, unknown>
      | null
      | undefined;
    const googleConnected = Boolean(googleAuth?.refreshToken);

    const barbeiros = await listAllBarbeirosForUser(profile.id);
    const barberNames = barbeiros.map((b) => b.nome);
    const barberFilter = String(req.query.barber ?? 'all').trim();

    if (!googleConnected) {
      return res.json({
        events: [],
        googleConnected: false,
        store_name: profile.store_name ?? 'Loja',
        slug,
        barbeiros: barbeiros.map((b) => ({ id: b.id, nome: b.nome, ativo: b.ativo })),
      });
    }

    const email = String(profile.email).toLowerCase().trim();
    let events = await listCalendarEvents(email, from, to);
    events = filterEventsByBarber(events, barberFilter, barberNames);

    res.json({
      events,
      googleConnected: true,
      store_name: profile.store_name ?? 'Loja',
      slug,
      barbeiros: barbeiros.map((b) => ({ id: b.id, nome: b.nome, ativo: b.ativo })),
    });
  } catch {
    res.status(500).json({ error: 'Erro ao carregar calendário público.' });
  }
});

export default router;
