import express, { Request, Response } from 'express';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { supabase } from '../lib/supabase';
import { profileHasMultiBarberPlan } from '../lib/profileMultiBarber';
import { countBarbeirosForUser, listAllBarbeirosForUser } from '../lib/barbeiros';

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function requireAuth(req: Request) {
  return getUserFromBearerHeader(supabase, req.headers.authorization);
}

router.get('/', async (req: Request, res: Response) => {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('multi_barber_plan')
    .eq('id', auth.user.id)
    .maybeSingle();

  const barbeiros = await listAllBarbeirosForUser(auth.user.id);

  res.json({
    multi_barber_plan: profileHasMultiBarberPlan(profile),
    barbeiros,
    can_manage_team: profileHasMultiBarberPlan(profile),
  });
});

router.post('/', async (req: Request, res: Response) => {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('multi_barber_plan')
    .eq('id', auth.user.id)
    .maybeSingle();

  const hasPlan = profileHasMultiBarberPlan(profile);
  const total = await countBarbeirosForUser(auth.user.id);

  if (!hasPlan) {
    return res.status(403).json({
      error: 'upgrade_required',
      message: 'O Plano Multi-Barbeiro é necessário para cadastrar profissionais na equipe.',
    });
  }

  const nome = String(req.body?.nome ?? '').trim();
  const google_calendar_email = String(req.body?.google_calendar_email ?? '')
    .trim()
    .toLowerCase();

  if (!nome) {
    return res.status(400).json({ error: 'Informe o nome do barbeiro.' });
  }
  if (!EMAIL_RE.test(google_calendar_email)) {
    return res.status(400).json({ error: 'Informe um e-mail válido do Google Agenda.' });
  }

  if (total >= 30) {
    return res.status(400).json({ error: 'Limite máximo de 30 profissionais atingido.' });
  }

  const { data, error } = await supabase
    .from('barbeiros')
    .insert({
      user_id: auth.user.id,
      nome,
      google_calendar_email,
      ativo: true,
    })
    .select('id, user_id, nome, google_calendar_email, ativo, created_at')
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

  const { data: profile } = await supabase
    .from('profiles')
    .select('multi_barber_plan')
    .eq('id', auth.user.id)
    .maybeSingle();

  if (!profileHasMultiBarberPlan(profile)) {
    return res.status(403).json({
      error: 'upgrade_required',
      message: 'O Plano Multi-Barbeiro é necessário para editar a equipe.',
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

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar.' });
  }

  const { data, error } = await supabase
    .from('barbeiros')
    .update(patch)
    .eq('id', id)
    .eq('user_id', auth.user.id)
    .select('id, user_id, nome, google_calendar_email, ativo, created_at')
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

  const { data: profile } = await supabase
    .from('profiles')
    .select('multi_barber_plan')
    .eq('id', auth.user.id)
    .maybeSingle();

  if (!profileHasMultiBarberPlan(profile)) {
    return res.status(403).json({
      error: 'upgrade_required',
      message: 'O Plano Multi-Barbeiro é necessário para remover profissionais.',
    });
  }

  const { error } = await supabase
    .from('barbeiros')
    .delete()
    .eq('id', String(req.params.id))
    .eq('user_id', auth.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export default router;
