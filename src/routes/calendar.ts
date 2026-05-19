import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { profileHasWagooAccess } from '../lib/profileAccess';
import { listAllBarbeirosForUser } from '../lib/barbeiros';
import { syncCalendarShareSlug } from '../lib/storeSlug';
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

async function loadProfileForOwner(userId: string) {
  return supabase
    .from('profiles')
    .select('id, email, store_name, has_paid, complimentary_access_until, googleAuth, calendar_share_token')
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
        store_name: profile.store_name ?? 'Barbearia',
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
      store_name: profile.store_name ?? 'Barbearia',
      slug,
      barbeiros: barbeiros.map((b) => ({ id: b.id, nome: b.nome, ativo: b.ativo })),
    });
  } catch {
    res.status(500).json({ error: 'Erro ao carregar calendário público.' });
  }
});

export default router;
