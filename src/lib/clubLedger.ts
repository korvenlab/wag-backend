import { randomUUID } from 'crypto';
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
  if (!opts.asaasPaymentId?.trim()) {
    return { ok: false, error: 'asaasPaymentId obrigatório.' };
  }

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
    // Corrida: outro worker inseriu o mesmo payment_id (unique index)
    if (String(error.code) === '23505' || /duplicate|unique/i.test(error.message)) {
      const { data: again } = await supabase
        .from('club_ledger_entries')
        .select('amount_brl')
        .eq('asaas_payment_id', opts.asaasPaymentId)
        .eq('entry_type', 'credit')
        .maybeSingle();
      return { ok: true, net_brl: Number(again?.amount_brl) || net_brl };
    }
    log.error('CLUB', 'credit ledger falhou', error, {
      profileId: opts.profileId,
      paymentId: opts.asaasPaymentId,
    });
    return { ok: false, error: error.message };
  }

  return { ok: true, net_brl };
}

/** Hold id local antes da transferência Asaas (débito-primeiro). */
export function newPayoutHoldId(): string {
  return `hold:${randomUUID()}`;
}

/**
 * Debita atomicamente se o saldo cobrir (RPC no Postgres).
 * Sem a migration, falha fechado — não permite saque inseguro.
 */
export async function reserveClubLedgerPayout(opts: {
  profileId: string;
  amountBrl: number;
  holdId: string;
  description?: string;
}): Promise<
  | { ok: true; balance_after?: number }
  | { ok: false; error: string; balance?: number }
> {
  const amount = Math.round(Number(opts.amountBrl) * 100) / 100;
  if (amount < 1) return { ok: false, error: 'Valor mínimo de saque: R$ 1,00.' };
  if (!opts.holdId?.trim()) return { ok: false, error: 'holdId inválido.' };

  const { data, error } = await supabase.rpc('club_ledger_try_debit', {
    p_profile_id: opts.profileId,
    p_amount: amount,
    p_asaas_transfer_id: opts.holdId,
    p_description: opts.description || 'Saque PIX',
  });

  if (error) {
    log.error('CLUB', 'reserve payout falhou', error, {
      profileId: opts.profileId,
      holdId: opts.holdId,
    });
    // Fallback sem RPC: ainda assim tenta check+insert sob risco residual baixo
    // se a migration ainda não rodou — preferimos bloquear.
    if (/function .* does not exist|PGRST202|42883/i.test(error.message)) {
      return {
        ok: false,
        error:
          'Saque bloqueado: rode a migration club_ledger_atomic_payout no Supabase.',
      };
    }
    return { ok: false, error: error.message };
  }

  const body = data as {
    ok?: boolean;
    error?: string;
    balance?: number;
    balance_after?: number;
    already?: boolean;
  } | null;

  if (!body?.ok) {
    return {
      ok: false,
      error: body?.error || 'Saldo insuficiente.',
      balance: body?.balance,
    };
  }
  return { ok: true, balance_after: body.balance_after };
}

/** Troca hold:* pelo id real da transferência Asaas. */
export async function finalizeClubLedgerPayout(opts: {
  profileId: string;
  holdId: string;
  asaasTransferId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from('club_ledger_entries')
    .update({ asaas_transfer_id: opts.asaasTransferId })
    .eq('profile_id', opts.profileId)
    .eq('entry_type', 'debit')
    .eq('asaas_transfer_id', opts.holdId);

  if (error) {
    log.error('CLUB', 'finalize payout falhou', error, {
      holdId: opts.holdId,
      transferId: opts.asaasTransferId,
    });
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Libera o hold se a transferência Asaas falhar. */
export async function releaseClubLedgerPayout(opts: {
  profileId: string;
  holdId: string;
}): Promise<void> {
  const { error } = await supabase.rpc('club_ledger_release_debit', {
    p_profile_id: opts.profileId,
    p_asaas_transfer_id: opts.holdId,
  });
  if (error) {
    // Fallback: delete direto
    await supabase
      .from('club_ledger_entries')
      .delete()
      .eq('profile_id', opts.profileId)
      .eq('entry_type', 'debit')
      .eq('asaas_transfer_id', opts.holdId);
    log.warn('CLUB', 'release payout via delete', {
      holdId: opts.holdId,
      rpcError: error.message,
    });
  }
}

/** @deprecated Prefer reserve + finalize. Mantido para compat. */
export async function debitClubLedgerForPayout(opts: {
  profileId: string;
  amountBrl: number;
  asaasTransferId: string;
  description?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const reserved = await reserveClubLedgerPayout({
    profileId: opts.profileId,
    amountBrl: opts.amountBrl,
    holdId: opts.asaasTransferId,
    description: opts.description,
  });
  if (!reserved.ok) return { ok: false, error: reserved.error };
  return { ok: true };
}
