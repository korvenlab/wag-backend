import type { Request, Response } from 'express';
import type { User } from '@supabase/supabase-js';
import { getUserFromBearerHeader } from './supabaseAuthUser';
import { supabase } from './supabase';
import { log } from './logger';

export type AuthedRequest = {
  user: User;
  email: string;
};

/** Exige Bearer Supabase e devolve user + email normalizado. */
export async function requireBearerUser(
  req: Request,
  res: Response,
): Promise<AuthedRequest | null> {
  const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
  if (!auth.ok) {
    log.warn('AUTH', 'Bearer rejeitado', {
      path: req.path,
      reason: auth.reason,
    });
    res.status(401).json({
      error:
        auth.reason === 'missing_token'
          ? 'Envie Authorization: Bearer com o access_token da sessão.'
          : 'Sessão inválida ou expirada. Faça login novamente.',
    });
    return null;
  }

  const email = auth.user.email ? String(auth.user.email).trim().toLowerCase() : '';
  if (!email) {
    log.warn('AUTH', 'conta sem e-mail', { userId: auth.user.id, path: req.path });
    res.status(400).json({ error: 'Conta sem e-mail. Faça login com Google novamente.' });
    return null;
  }

  return { user: auth.user, email };
}

export { sanitizeProfileForClient } from './profileSanitize';
