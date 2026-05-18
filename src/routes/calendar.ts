import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { profileHasWagooAccess } from '../lib/profileAccess';
import { listCalendarEvents } from '../services/calendar';

const router = Router();

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

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('email, has_paid, complimentary_access_until, googleAuth')
      .eq('id', auth.user.id)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!profile) return res.status(404).json({ error: 'Perfil não encontrado' });

    const row = profile as Record<string, unknown>;
    if (
      !profileHasWagooAccess({
        has_paid: row.has_paid,
        complimentary_access_until: row.complimentary_access_until,
      })
    ) {
      return res.status(403).json({ error: 'Assinatura activa necessária para ver a agenda.' });
    }

    const from = String(req.query.from ?? '').trim();
    const to = String(req.query.to ?? '').trim();
    if (!from || !to) {
      return res.status(400).json({ error: 'Parâmetros from e to (ISO) são obrigatórios.' });
    }

    const googleAuth = row.googleAuth as Record<string, unknown> | null | undefined;
    const googleConnected = Boolean(googleAuth?.refreshToken);

    if (!googleConnected) {
      return res.json({ events: [], googleConnected: false });
    }

    const email = String(profile.email).toLowerCase().trim();
    const events = await listCalendarEvents(email, from, to);

    res.json({ events, googleConnected: true });
  } catch {
    res.status(500).json({ error: 'Erro ao carregar agenda.' });
  }
});

export default router;
