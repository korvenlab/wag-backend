import { supabase } from './supabase';

export type BarbeiroRow = {
  id: string;
  user_id: string;
  nome: string;
  google_calendar_email: string;
  ativo: boolean;
  created_at?: string;
};

export async function listActiveBarbeirosForUser(userId: string): Promise<BarbeiroRow[]> {
  const { data, error } = await supabase
    .from('barbeiros')
    .select('id, user_id, nome, google_calendar_email, ativo, created_at')
    .eq('user_id', userId)
    .eq('ativo', true)
    .order('nome', { ascending: true });

  if (error) {
    console.error('[barbeiros] listActive:', error.message);
    return [];
  }
  return (data ?? []) as BarbeiroRow[];
}

export async function listAllBarbeirosForUser(userId: string): Promise<BarbeiroRow[]> {
  const { data, error } = await supabase
    .from('barbeiros')
    .select('id, user_id, nome, google_calendar_email, ativo, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[barbeiros] listAll:', error.message);
    return [];
  }
  return (data ?? []) as BarbeiroRow[];
}

export async function countBarbeirosForUser(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('barbeiros')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (error) return 0;
  return count ?? 0;
}

export type ResolvedBarber = {
  id: string | null;
  nome: string;
  email: string | null;
};

export function resolveBarberFromSelection(
  barbeiros: BarbeiroRow[],
  selection: string | null | undefined,
): ResolvedBarber | null {
  if (!selection || !barbeiros.length) return null;
  const norm = selection.trim().toLowerCase();
  if (
    norm === 'sem_preferencia' ||
    norm === 'sem preferência' ||
    norm === 'sem preferencia' ||
    norm === 'sem preferência.'
  ) {
    return { id: null, nome: 'Sem Preferência', email: null };
  }
  const match =
    barbeiros.find((b) => b.nome.trim().toLowerCase() === norm) ||
    barbeiros.find((b) => b.id === selection);
  if (!match) return null;
  return {
    id: match.id,
    nome: match.nome,
    email: match.google_calendar_email,
  };
}
