import express, { Request, Response } from 'express';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { supabase } from '../lib/supabase';
import { profileSubscriptionTier } from '../lib/profileMultiBarber';
import { countBarbeirosForUser, listAllBarbeirosForUser } from '../lib/barbeiros';
import {
  canManageTeam,
  getMaxBarbeirosSlots,
  WAGOO_PLANS,
} from '../lib/wagooSubscription';

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    .select('id, user_id, nome, google_calendar_email, ativo, commission_percent, created_at')
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json(data);
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
    .select('id, user_id, nome, google_calendar_email, ativo, commission_percent, created_at')
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
