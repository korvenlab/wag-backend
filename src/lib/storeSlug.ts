import type { SupabaseClient } from '@supabase/supabase-js';

/** Gera slug URL-safe a partir do nome da loja (configurações). */
export function slugifyStoreName(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return base || 'loja';
}

async function slugTaken(
  supabase: SupabaseClient,
  slug: string,
  excludeUserId?: string,
): Promise<boolean> {
  let q = supabase.from('profiles').select('id').eq('calendar_share_token', slug);
  if (excludeUserId) q = q.neq('id', excludeUserId);
  const { data } = await q.maybeSingle();
  return Boolean(data);
}

/** Slug único para o link público do calendário. */
export async function resolveUniqueCalendarSlug(
  supabase: SupabaseClient,
  storeName: string,
  excludeUserId?: string,
): Promise<string> {
  const base = slugifyStoreName(storeName);
  let candidate = base;
  let n = 2;
  while (await slugTaken(supabase, candidate, excludeUserId)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

export async function syncCalendarShareSlug(
  supabase: SupabaseClient,
  userId: string,
  storeName: string | null | undefined,
  currentSlug: string | null | undefined,
): Promise<{ slug: string | null; error?: string }> {
  const trimmed = String(storeName ?? '').trim();
  if (!trimmed) {
    return { slug: null, error: 'Configure o nome da loja nas configurações.' };
  }

  const desiredBase = slugifyStoreName(trimmed);
  if (currentSlug && (currentSlug === desiredBase || currentSlug.startsWith(`${desiredBase}-`))) {
    return { slug: currentSlug };
  }

  const slug = await resolveUniqueCalendarSlug(supabase, trimmed, userId);
  const { error } = await supabase
    .from('profiles')
    .update({ calendar_share_token: slug })
    .eq('id', userId);

  if (error) return { slug: null, error: error.message };
  return { slug };
}
