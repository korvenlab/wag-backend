import express, { Request, Response } from 'express';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { supabase } from '../lib/supabase';
import { profileSubscriptionTier } from '../lib/profileMultiBarber';
import { listAllBarbeirosForUser } from '../lib/barbeiros';
import {
  canManageTeam,
  getMaxBarbeirosSlots,
  WAGOO_PLANS,
} from '../lib/wagooSubscription';
import {
  buildPublicBarberCommission,
  currentYearMonthBR,
  generateCommissionShareToken,
  loadBarberMonthAppointments,
  monthRangeIsoBR,
} from '../lib/barberCommissionShare';
import type { ManualEarningsEntry } from '../lib/csvCommissionExport';
import { loadPaidAppointmentsForExport } from './analytics';
import { frontendBaseUrl } from '../lib/stripeClient';
import { listCalendarEvents } from '../services/calendar';
import { foldName } from '../lib/csvCommissionExport';
import type { PublicScheduleAppointment } from '../lib/barberCommissionShare';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { BR_TZ } from '../lib/dateTimeBR';

dayjs.extend(utc);
dayjs.extend(timezone);

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function loadManualEntriesForMonth(
  profileId: string,
  year: number,
  month: number,
): Promise<ManualEarningsEntry[]> {
  const { data, error } = await supabase
    .from('barber_earnings_entries')
    .select('barber_name, amount_brl, period_year, period_month')
    .eq('profile_id', profileId)
    .eq('period_year', year)
    .eq('period_month', month);

  if (error) {
    console.error('[barbeiros] commission share entries:', error.message);
    return [];
  }

  return (data ?? []).map((r) => ({
    barber_name: String(r.barber_name),
    amount_brl: Number(r.amount_brl) || 0,
    period_year: Number(r.period_year),
    period_month: Number(r.period_month),
  }));
}

async function requireAuth(req: Request) {
  return getUserFromBearerHeader(supabase, req.headers.authorization);
}

async function loadTeamContext(userId: string) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('subscription_tier, has_paid, multi_barber_plan')
    .eq('id', userId)
    .maybeSingle();

  const tier = profileSubscriptionTier(profile);
  const barbeiros = await listAllBarbeirosForUser(userId);
  const used = barbeiros.length;
  const max = getMaxBarbeirosSlots(tier);

  return {
    tier,
    barbeiros,
    used,
    max,
    can_manage_team: canManageTeam(tier),
    can_add_team_member: tier !== null && used < max,
    plan_label: tier ? WAGOO_PLANS[tier].label : null,
  };
}

router.get('/', async (req: Request, res: Response) => {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }

  const ctx = await loadTeamContext(auth.user.id);

  res.json({
    subscription_tier: ctx.tier,
    multi_barber_plan: ctx.tier === 'pro' || ctx.tier === 'pro_plus',
    max_team_users: ctx.max,
    team_users_used: ctx.used,
    barbeiros: ctx.barbeiros,
    can_manage_team: ctx.can_manage_team,
    can_add_team_member: ctx.can_add_team_member,
    plan_label: ctx.plan_label,
  });
});

router.post('/', async (req: Request, res: Response) => {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }

  const ctx = await loadTeamContext(auth.user.id);

  if (!ctx.tier) {
    return res.status(403).json({
      error: 'upgrade_required',
      message: 'Assine um plano Wagoo para cadastrar profissionais na equipe.',
    });
  }

  if (!ctx.can_manage_team) {
    return res.status(403).json({
      error: 'upgrade_required',
      message: 'Gerenciar equipe está disponível nos planos Pro e Pro+.',
      subscription_tier: ctx.tier,
    });
  }

  if (ctx.used >= ctx.max) {
    const planName = ctx.plan_label ?? 'atual';
    return res.status(403).json({
      error: 'team_limit_reached',
      message: `Limite de ${ctx.max} usuário(s) no plano ${planName}. Faça upgrade para adicionar mais profissionais.`,
      max_team_users: ctx.max,
      team_users_used: ctx.used,
      subscription_tier: ctx.tier,
    });
  }

  const nome = String(req.body?.nome ?? '').trim();
  const google_calendar_email = String(req.body?.google_calendar_email ?? '')
    .trim()
    .toLowerCase();
  const commissionRaw = req.body?.commission_percent ?? req.body?.commissionPercent;
  let commission_percent = 0;
  if (commissionRaw !== undefined && commissionRaw !== null && commissionRaw !== '') {
    const pct = Number(commissionRaw);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ error: 'Comissão deve ser um percentual entre 0 e 100.' });
    }
    commission_percent = Math.round(pct * 100) / 100;
  }

  if (!nome) {
    return res.status(400).json({ error: 'Informe o nome do barbeiro.' });
  }
  if (!EMAIL_RE.test(google_calendar_email)) {
    return res.status(400).json({ error: 'Informe um e-mail válido do Google Agenda.' });
  }

  const { data, error } = await supabase
    .from('barbeiros')
    .insert({
      user_id: auth.user.id,
      nome,
      google_calendar_email,
      ativo: true,
      commission_percent,
    })
    .select(
      'id, user_id, nome, google_calendar_email, ativo, commission_percent, commission_share_token, created_at',
    )
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json(data);
});

/** Gera ou renova o link privado de comissão do profissional. */
router.post('/:id/commission-share', async (req: Request, res: Response) => {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }

  const ctx = await loadTeamContext(auth.user.id);
  if (!ctx.can_manage_team) {
    return res.status(403).json({
      error: 'upgrade_required',
      message: 'Gerenciar equipe está disponível nos planos Pro e Pro+.',
    });
  }

  const id = String(req.params.id);
  const rotate = Boolean(req.body?.rotate ?? req.query?.rotate);

  const { data: existing } = await supabase
    .from('barbeiros')
    .select('id, commission_share_token')
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .maybeSingle();

  if (!existing) {
    return res.status(404).json({ error: 'Profissional não encontrado.' });
  }

  const current = existing.commission_share_token
    ? String(existing.commission_share_token)
    : null;
  const token =
    !rotate && current ? current : generateCommissionShareToken();

  if (token !== current) {
    const { error } = await supabase
      .from('barbeiros')
      .update({ commission_share_token: token })
      .eq('id', id)
      .eq('user_id', auth.user.id);
    if (error) return res.status(500).json({ error: error.message });
  }

  const base = frontendBaseUrl() || '';
  const path = `/comissao/${token}`;
  res.json({
    commission_share_token: token,
    share_path: path,
    share_url: base ? `${base}${path}` : path,
  });
});

/** Revoga o link privado (invalida o token atual). */
router.delete('/:id/commission-share', async (req: Request, res: Response) => {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }

  const ctx = await loadTeamContext(auth.user.id);
  if (!ctx.can_manage_team) {
    return res.status(403).json({
      error: 'upgrade_required',
      message: 'Gerenciar equipe está disponível nos planos Pro e Pro+.',
    });
  }

  const id = String(req.params.id);
  const { data, error } = await supabase
    .from('barbeiros')
    .update({ commission_share_token: null })
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .select('id')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Profissional não encontrado.' });

  res.json({ ok: true });
});

/**
 * Página pública do profissional: só os ganhos dele no mês.
 * Sem autenticação — o token é o segredo.
 */
router.get('/public/commission/:token', async (req: Request, res: Response) => {
  const token = String(req.params.token || '').trim();
  if (!token || token.length < 16) {
    return res.status(404).json({ error: 'Link inválido ou expirado.' });
  }

  const { data: barbeiro, error } = await supabase
    .from('barbeiros')
    .select(
      'id, user_id, nome, google_calendar_email, ativo, commission_percent, commission_share_token, created_at',
    )
    .eq('commission_share_token', token)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!barbeiro) {
    return res.status(404).json({ error: 'Link inválido ou expirado.' });
  }

  const now = currentYearMonthBR();
  let year = Number(req.query.year);
  let month = Number(req.query.month);
  if (!Number.isFinite(year) || year < 2000 || year > 2100) year = now.year;
  if (!Number.isFinite(month) || month < 1 || month > 12) month = now.month;

  const { from, to } = monthRangeIsoBR(year, month);
  const ownerId = String(barbeiro.user_id);

  const [team, paidAppointments, manualEntries, profile, agendaAppointments] =
    await Promise.all([
      listAllBarbeirosForUser(ownerId),
      loadPaidAppointmentsForExport(ownerId, from, to),
      loadManualEntriesForMonth(ownerId, year, month),
      supabase
        .from('profiles')
        .select('store_name, email, googleAuth')
        .eq('id', ownerId)
        .maybeSingle()
        .then((r) => r.data),
      loadBarberMonthAppointments({
        profileId: ownerId,
        barberName: String(barbeiro.nome),
        from,
        to,
      }),
    ]);

  const row = team.find((b) => b.id === String(barbeiro.id));
  if (!row) {
    return res.status(404).json({ error: 'Link inválido ou expirado.' });
  }

  // Complementa com Google Agenda do salão, só eventos desse profissional
  let appointments = agendaAppointments;
  const googleAuth = profile?.googleAuth as Record<string, unknown> | null | undefined;
  const ownerEmail = String(profile?.email || '')
    .toLowerCase()
    .trim();
  if (googleAuth?.refreshToken && ownerEmail) {
    try {
      const events = await listCalendarEvents(ownerEmail, from, to);
      const barberKey = foldName(row.nome);
      const fromGoogle: PublicScheduleAppointment[] = [];
      for (const ev of events) {
        const tagged = ev.barberName ? foldName(ev.barberName) : '';
        if (tagged && tagged !== barberKey) continue;
        // Sem tag de barbeiro: só inclui se for o único da equipe ou se o título/desc casar
        if (!tagged && team.length > 1) continue;

        const startBr = dayjs(ev.start).tz(BR_TZ);
        const endBr = dayjs(ev.end).tz(BR_TZ);
        fromGoogle.push({
          id: `gcal-${ev.id}`,
          starts_at: ev.start,
          ends_at: ev.end,
          day: startBr.format('YYYY-MM-DD'),
          time_label: `${startBr.format('HH:mm')} – ${endBr.format('HH:mm')}`,
          client_name: ev.clientName?.trim() || ev.summary?.trim() || 'Cliente',
          service_name: null,
          price_brl: 0,
          payment_status: null,
          status: 'confirmed',
        });
      }

      // Evita duplicar o mesmo horário já vindo da Agenda Web
      const seen = new Set(
        appointments.map(
          (a) => `${a.day}|${a.time_label}|${foldName(a.client_name)}`,
        ),
      );
      for (const g of fromGoogle) {
        const k = `${g.day}|${g.time_label}|${foldName(g.client_name)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        appointments.push(g);
      }
      appointments.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    } catch (err) {
      console.error('[commission-share] google calendar:', err);
    }
  }

  const payload = buildPublicBarberCommission({
    barbeiro: row,
    storeName: profile?.store_name ? String(profile.store_name) : null,
    year,
    month,
    paidAppointments,
    manualEntries,
    teamBarbeiros: team,
    appointments,
  });

  res.json(payload);
});

router.patch('/:id', async (req: Request, res: Response) => {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }

  const ctx = await loadTeamContext(auth.user.id);

  if (!ctx.can_manage_team) {
    return res.status(403).json({
      error: 'upgrade_required',
      message: 'Assine um plano Wagoo para editar a equipe.',
    });
  }

  const id = String(req.params.id);
  const patch: Record<string, unknown> = {};

  if (req.body?.nome !== undefined) {
    const nome = String(req.body.nome).trim();
    if (!nome) return res.status(400).json({ error: 'Nome inválido.' });
    patch.nome = nome;
  }
  if (req.body?.google_calendar_email !== undefined) {
    const email = String(req.body.google_calendar_email).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'E-mail do Google Agenda inválido.' });
    }
    patch.google_calendar_email = email;
  }
  if (req.body?.ativo !== undefined) {
    patch.ativo = Boolean(req.body.ativo);
  }
  if (req.body?.commission_percent !== undefined || req.body?.commissionPercent !== undefined) {
    const pct = Number(req.body?.commission_percent ?? req.body?.commissionPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ error: 'Comissão deve ser um percentual entre 0 e 100.' });
    }
    patch.commission_percent = Math.round(pct * 100) / 100;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar.' });
  }

  const { data, error } = await supabase
    .from('barbeiros')
    .update(patch)
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .select(
      'id, user_id, nome, google_calendar_email, ativo, commission_percent, commission_share_token, created_at',
    )
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Profissional não encontrado.' });

  res.json(data);
});

router.delete('/:id', async (req: Request, res: Response) => {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }

  const ctx = await loadTeamContext(auth.user.id);

  if (!ctx.can_manage_team) {
    return res.status(403).json({
      error: 'upgrade_required',
      message: 'Assine um plano Wagoo para remover profissionais.',
    });
  }

  const id = String(req.params.id);

  const { data: existing } = await supabase
    .from('barbeiros')
    .select('id')
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .maybeSingle();

  if (!existing) {
    return res.status(404).json({ error: 'Profissional não encontrado.' });
  }

  const { error } = await supabase
    .from('barbeiros')
    .delete()
    .eq('id', id)
    .eq('user_id', auth.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export default router;
