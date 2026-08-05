import { supabase } from './supabase';

export type BarbeiroRow = {
  id: string;
  user_id: string;
  nome: string;
  google_calendar_email: string;
  ativo: boolean;
  /** Percentual de comissão sobre valor do serviço (0–100). */
  commission_percent: number;
  /** Token opaco do link privado de comissão (somente o dono vê no painel). */
  commission_share_token: string | null;
  created_at?: string;
};

const BARBEIRO_SELECT =
  'id, user_id, nome, google_calendar_email, ativo, commission_percent, commission_share_token, created_at';

function normalizeBarbeiroRow(row: Record<string, unknown>): BarbeiroRow {
  const pct = Number(row.commission_percent);
  const token = row.commission_share_token;
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    nome: String(row.nome),
    google_calendar_email: String(row.google_calendar_email),
    ativo: Boolean(row.ativo),
    commission_percent: Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0,
    commission_share_token:
      token != null && String(token).trim() !== '' ? String(token) : null,
    created_at: row.created_at ? String(row.created_at) : undefined,
  };
}

export async function listActiveBarbeirosForUser(userId: string): Promise<BarbeiroRow[]> {
  const { data, error } = await supabase
    .from('barbeiros')
    .select(BARBEIRO_SELECT)
    .eq('user_id', userId)
    .eq('ativo', true)
    .order('nome', { ascending: true });

  if (error) {
    console.error('[barbeiros] listActive:', error.message);
    return [];
  }
  return (data ?? []).map((r) => normalizeBarbeiroRow(r as Record<string, unknown>));
}

export async function listAllBarbeirosForUser(userId: string): Promise<BarbeiroRow[]> {
  const { data, error } = await supabase
    .from('barbeiros')
    .select(BARBEIRO_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[barbeiros] listAll:', error.message);
    return [];
  }
  return (data ?? []).map((r) => normalizeBarbeiroRow(r as Record<string, unknown>));
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
