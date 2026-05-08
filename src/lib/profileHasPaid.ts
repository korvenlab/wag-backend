import type { SupabaseClient } from '@supabase/supabase-js';

export type SetProfileHasPaidResult =
  | { ok: true; rows: Array<{ id: string; has_paid: boolean }> }
  | { ok: false; error: string };

/**
 * Atualiza `profiles.has_paid` + `is_ai_enabled` para o UUID de `auth.users`.
 * Se não existir linha em `public.profiles`, faz upsert (caso comum: usuário em Auth sem perfil criado).
 */
export async function setProfileHasPaidByUserId(
  supabase: SupabaseClient,
  userId: string,
  hasPaid: boolean,
): Promise<SetProfileHasPaidResult> {
  const id = String(userId || '').trim();
  if (!id) return { ok: false, error: 'userId vazio' };

  const { data: updated, error: upErr } = await supabase
    .from('profiles')
    .update({ has_paid: hasPaid, is_ai_enabled: hasPaid })
    .eq('id', id)
    .select('id, has_paid');
  if (upErr) return { ok: false, error: upErr.message };
  if (updated?.length) {
    return {
      ok: true,
      rows: updated.map((r) => ({
        id: String(r.id),
        has_paid: Boolean((r as { has_paid?: boolean }).has_paid),
      })),
    };
  }

  const { data: authWrap, error: authErr } = await supabase.auth.admin.getUserById(id);
  if (authErr || !authWrap?.user) {
    return { ok: false, error: `auth.users sem id ${id}: ${authErr?.message ?? 'not found'}` };
  }
  const u = authWrap.user;
  const emailNorm = u.email ? String(u.email).trim().toLowerCase() : null;
  const row: Record<string, unknown> = {
    id,
    has_paid: hasPaid,
    is_ai_enabled: hasPaid,
    is_active: true,
  };
  if (emailNorm) row.email = emailNorm;

  const { data: inserted, error: insErr } = await supabase
    .from('profiles')
    .upsert(row, { onConflict: 'id' })
    .select('id, has_paid');
  if (insErr) return { ok: false, error: insErr.message };
  if (!inserted?.length) return { ok: false, error: 'upsert profiles não retornou linhas' };

  return {
    ok: true,
    rows: inserted.map((r) => ({
      id: String(r.id),
      has_paid: Boolean((r as { has_paid?: boolean }).has_paid),
    })),
  };
}
