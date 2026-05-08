import type { SupabaseClient, User } from '@supabase/supabase-js';

export type BearerAuthResult =
  | { ok: true; user: User }
  | { ok: false; reason: 'missing_token' | 'invalid_session' };

/** Valida `Authorization: Bearer <access_token>` com o cliente admin do Supabase. */
export async function getUserFromBearerHeader(
  supabase: SupabaseClient,
  authHeader: string | undefined
): Promise<BearerAuthResult> {
  const raw = typeof authHeader === 'string' ? authHeader.trim() : '';
  const token = raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : '';
  if (!token) return { ok: false, reason: 'missing_token' };

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return { ok: false, reason: 'invalid_session' };
  return { ok: true, user: data.user };
}
