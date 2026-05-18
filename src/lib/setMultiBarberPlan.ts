import type { SupabaseClient } from '@supabase/supabase-js';

export async function setProfileMultiBarberPlanByUserId(
  supabase: SupabaseClient,
  userId: string,
  active: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from('profiles')
    .update({ multi_barber_plan: active })
    .eq('id', userId);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
