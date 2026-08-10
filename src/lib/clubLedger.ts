import { supabase } from './supabase';
import { WAGOO_APPLICATION_FEE_PERCENT } from './connectFees';
import { log } from './logger';

export type ClubLedgerEntry = {
  id: string;
  profile_id: string;
  entry_type: 'credit' | 'debit' | 'adjustment';
  amount_brl: number;
  gross_brl: number | null;
  wagoo_fee_brl: number | null;
  description: string | null;
  club_member_id: string | null;
  asaas_payment_id: string | null;
  asaas_transfer_id: string | null;
  created_at: string;
};

export function clubNetFromGross(grossBrl: number): {
  gross_brl: number;
  wagoo_fee_brl: number;
  net_brl: number;
} {
  const gross = Math.round(Number(grossBrl) * 100) / 100;
  const fee =
    Math.round(gross * (WAGOO_APPLICATION_FEE_PERCENT / 100) * 100) / 100;
  const net = Math.round((gross - fee) * 100) / 100;
  return { gross_brl: gross, wagoo_fee_brl: fee, net_brl: Math.max(0, net) };
}

export async function getClubLedgerBalance(
  profileId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('club_ledger_entries')
    .select('entry_type, amount_brl')
    .eq('profile_id', profileId);

  if (error) {
    log.error('CLUB', 'ledger balance falhou', error, { profileId });
    return 0;
  }

  let bal = 0;
  for (const row of data || []) {
    const amt = Number(row.amount_brl) || 0;
    if (row.entry_type === 'credit' || row.entry_type === 'adjustment') {
      bal += amt;
    } else if (row.entry_type === 'debit') {
      bal -= amt;
    }
  }
  return Math.round(bal * 100) / 100;
}

export async function creditClubLedgerFromPayment(opts: {
  profileId: string;
  clubMemberId?: string | null;
  grossBrl: number;
  asaasPaymentId: string;
  description?: string;
}): Promise<{ ok: true; net_brl: number } | { ok: false; error: string }> {
  // Idempotência: mesmo payment_id não credita 2x
  const { data: existing } = await supabase
    .from('club_ledger_entries')
    .select('id, amount_brl')
    .eq('asaas_payment_id', opts.asaasPaymentId)
    .eq('entry_type', 'credit')
    .maybeSingle();

  if (existing?.id) {
    return { ok: true, net_brl: Number(existing.amount_brl) || 0 };
  }

  const { gross_brl, wagoo_fee_brl, net_brl } = clubNetFromGross(opts.grossBrl);
  if (net_brl < 0.01) {
    return { ok: false, error: 'Valor líquido inválido.' };
  }

  const { error } = await supabase.from('club_ledger_entries').insert({
    profile_id: opts.profileId,
    entry_type: 'credit',
    amount_brl: net_brl,
    gross_brl,
    wagoo_fee_brl,
    description: opts.description || 'Mensalidade do clube',
    club_member_id: opts.clubMemberId || null,
    asaas_payment_id: opts.asaasPaymentId,
  });

  if (error) {
    log.error('CLUB', 'credit ledger falhou', error, {
      profileId: opts.profileId,
      paymentId: opts.asaasPaymentId,
    });
    return { ok: false, error: error.message };
  }

  return { ok: true, net_brl };
}

export async function debitClubLedgerForPayout(opts: {
  profileId: string;
  amountBrl: number;
  asaasTransferId: string;
  description?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const amount = Math.round(Number(opts.amountBrl) * 100) / 100;
  if (amount < 1) return { ok: false, error: 'Valor mínimo de saque: R$ 1,00.' };

  const { data: existing } = await supabase
    .from('club_ledger_entries')
    .select('id')
    .eq('asaas_transfer_id', opts.asaasTransferId)
    .eq('entry_type', 'debit')
    .maybeSingle();
  if (existing?.id) return { ok: true };

  const { error } = await supabase.from('club_ledger_entries').insert({
    profile_id: opts.profileId,
    entry_type: 'debit',
    amount_brl: amount,
    gross_brl: null,
    wagoo_fee_brl: null,
    description: opts.description || 'Saque PIX clube',
    asaas_transfer_id: opts.asaasTransferId,
  });

  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
