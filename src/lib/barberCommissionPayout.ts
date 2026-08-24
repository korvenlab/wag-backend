import { supabase } from './supabase';
import type { BarbeiroRow } from './barbeiros';
import { monthRangeIsoBR, pickBarberTotalFromAnalytics } from './barberCommissionShare';
import { buildAnalyticsSummaryPayload } from '../routes/analytics';

export type CommissionPayoutRow = {
  id: string;
  profile_id: string;
  barbeiro_id: string;
  period_year: number;
  period_month: number;
  amount_brl: number | null;
  paid_at: string;
  note: string;
};

export type CommissionPayoutPublic = {
  paid: boolean;
  paid_at: string | null;
  amount_brl: number | null;
  note: string | null;
};

const MONTH_LABELS = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];

export function periodLabel(year: number, month: number): string {
  return `${MONTH_LABELS[month - 1] ?? month} de ${year}`;
}

export function formatMoneyBrl(n: number): string {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function buildCommissionWhatsAppMessage(opts: {
  profissional: string;
  periodLabel: string;
  finalAmountBrl: number;
  shareUrl: string;
}): string {
  const money = formatMoneyBrl(opts.finalAmountBrl);
  return (
    `Oi ${opts.profissional}, seu ganho em ${opts.periodLabel} foi ${money}.\n\n` +
    `Confira detalhes e horários: ${opts.shareUrl}`
  );
}

export async function loadPayoutForBarberMonth(opts: {
  barbeiroId: string;
  year: number;
  month: number;
}): Promise<CommissionPayoutRow | null> {
  const { data, error } = await supabase
    .from('barber_commission_payouts')
    .select('id, profile_id, barbeiro_id, period_year, period_month, amount_brl, paid_at, note')
    .eq('barbeiro_id', opts.barbeiroId)
    .eq('period_year', opts.year)
    .eq('period_month', opts.month)
    .maybeSingle();

  if (error) {
    console.error('[commission-payout] load:', error.message);
    return null;
  }
  if (!data) return null;

  return {
    id: String(data.id),
    profile_id: String(data.profile_id),
    barbeiro_id: String(data.barbeiro_id),
    period_year: Number(data.period_year),
    period_month: Number(data.period_month),
    amount_brl: data.amount_brl != null ? Number(data.amount_brl) : null,
    paid_at: String(data.paid_at),
    note: String(data.note ?? ''),
  };
}

export async function loadPayoutsForProfileMonth(opts: {
  profileId: string;
  year: number;
  month: number;
}): Promise<Map<string, CommissionPayoutRow>> {
  const { data, error } = await supabase
    .from('barber_commission_payouts')
    .select('id, profile_id, barbeiro_id, period_year, period_month, amount_brl, paid_at, note')
    .eq('profile_id', opts.profileId)
    .eq('period_year', opts.year)
    .eq('period_month', opts.month);

  if (error) {
    console.error('[commission-payout] load batch:', error.message);
    return new Map();
  }

  const map = new Map<string, CommissionPayoutRow>();
  for (const row of data ?? []) {
    map.set(String(row.barbeiro_id), {
      id: String(row.id),
      profile_id: String(row.profile_id),
      barbeiro_id: String(row.barbeiro_id),
      period_year: Number(row.period_year),
      period_month: Number(row.period_month),
      amount_brl: row.amount_brl != null ? Number(row.amount_brl) : null,
      paid_at: String(row.paid_at),
      note: String(row.note ?? ''),
    });
  }
  return map;
}

export function toPublicPayout(row: CommissionPayoutRow | null | undefined): CommissionPayoutPublic {
  if (!row) {
    return { paid: false, paid_at: null, amount_brl: null, note: null };
  }
  return {
    paid: true,
    paid_at: row.paid_at,
    amount_brl: row.amount_brl,
    note: row.note.trim() || null,
  };
}

export async function markCommissionPayout(opts: {
  profileId: string;
  barbeiroId: string;
  year: number;
  month: number;
  amountBrl?: number | null;
  note?: string;
}): Promise<CommissionPayoutRow | null> {
  const payload = {
    profile_id: opts.profileId,
    barbeiro_id: opts.barbeiroId,
    period_year: opts.year,
    period_month: opts.month,
    amount_brl:
      opts.amountBrl != null && Number.isFinite(opts.amountBrl)
        ? Math.round(opts.amountBrl * 100) / 100
        : null,
    paid_at: new Date().toISOString(),
    note: String(opts.note ?? '').trim(),
  };

  const { data, error } = await supabase
    .from('barber_commission_payouts')
    .upsert(payload, { onConflict: 'barbeiro_id,period_year,period_month' })
    .select('id, profile_id, barbeiro_id, period_year, period_month, amount_brl, paid_at, note')
    .single();

  if (error) {
    console.error('[commission-payout] mark:', error.message);
    return null;
  }

  return {
    id: String(data.id),
    profile_id: String(data.profile_id),
    barbeiro_id: String(data.barbeiro_id),
    period_year: Number(data.period_year),
    period_month: Number(data.period_month),
    amount_brl: data.amount_brl != null ? Number(data.amount_brl) : null,
    paid_at: String(data.paid_at),
    note: String(data.note ?? ''),
  };
}

export async function clearCommissionPayout(opts: {
  profileId: string;
  barbeiroId: string;
  year: number;
  month: number;
}): Promise<boolean> {
  const { error } = await supabase
    .from('barber_commission_payouts')
    .delete()
    .eq('profile_id', opts.profileId)
    .eq('barbeiro_id', opts.barbeiroId)
    .eq('period_year', opts.year)
    .eq('period_month', opts.month);

  if (error) {
    console.error('[commission-payout] clear:', error.message);
    return false;
  }
  return true;
}

export type BarberCommissionSnapshot = {
  final_amount_brl: number;
  payout: CommissionPayoutPublic;
};

export async function loadBarberCommissionSnapshots(opts: {
  profileId: string;
  barbeiros: BarbeiroRow[];
  year: number;
  month: number;
}): Promise<Record<string, BarberCommissionSnapshot>> {
  const { from, to } = monthRangeIsoBR(opts.year, opts.month);
  const [analytics, payouts] = await Promise.all([
    buildAnalyticsSummaryPayload(opts.profileId, from, to),
    loadPayoutsForProfileMonth({
      profileId: opts.profileId,
      year: opts.year,
      month: opts.month,
    }),
  ]);

  const out: Record<string, BarberCommissionSnapshot> = {};
  for (const barbeiro of opts.barbeiros) {
    const row = pickBarberTotalFromAnalytics(analytics.barbers, barbeiro.nome);
    out[barbeiro.id] = {
      final_amount_brl: row?.final_amount_brl ?? 0,
      payout: toPublicPayout(payouts.get(barbeiro.id)),
    };
  }
  return out;
}
