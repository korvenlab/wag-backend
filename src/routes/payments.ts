import express, { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { profileHasWagooAccess } from '../lib/profileAccess';
import { asaasConfigured, asaasTransferPix } from '../lib/asaasClient';
import {
  debitClubLedgerForPayout,
  getClubLedgerBalance,
  clubNetFromGross,
} from '../lib/clubLedger';
import {
  WAGOO_APPLICATION_FEE_PERCENT,
  BOOKING_PAYMENT_HOLD_MINUTES,
  computeDepositBrl,
} from '../lib/connectFees';
import { log } from '../lib/logger';

const router = Router();

type PixKeyType = 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP';

function detectPixKeyType(raw: string): PixKeyType | null {
  const key = String(raw || '').trim();
  if (!key) return null;
  if (key.includes('@')) return 'EMAIL';
  const digits = key.replace(/\D/g, '');
  if (digits.length === 11) return 'CPF';
  if (digits.length === 14) return 'CNPJ';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    return 'EVP';
  }
  if (digits.length >= 10 && digits.length <= 13) return 'PHONE';
  return 'EVP';
}

function normalizePixKey(key: string, type: PixKeyType): string {
  const raw = key.trim();
  if (type === 'EMAIL') return raw.toLowerCase();
  if (type === 'CPF' || type === 'CNPJ' || type === 'PHONE') return raw.replace(/\D/g, '');
  return raw;
}

async function requireOwner(req: Request) {
  const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
  if (!auth.ok) {
    return {
      ok: false as const,
      status: 401,
      error:
        auth.reason === 'missing_token'
          ? 'Faça login e envie Authorization: Bearer.'
          : 'Sessão inválida.',
    };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select(
      'id, has_paid, complimentary_access_until, booking_deposit_enabled, booking_deposit_percent, booking_advance_pay_enabled, club_payout_pix_key, club_payout_pix_key_type',
    )
    .eq('id', auth.user.id)
    .maybeSingle();

  if (!profile) return { ok: false as const, status: 404, error: 'Perfil não encontrado.' };

  if (
    !profileHasWagooAccess({
      has_paid: profile.has_paid,
      complimentary_access_until: profile.complimentary_access_until,
    })
  ) {
    return { ok: false as const, status: 403, error: 'Assinatura activa necessária.' };
  }

  return { ok: true as const, userId: auth.user.id, profile };
}

/** Status do wallet Asaas + configs de sinal. */
router.get('/me', async (req: Request, res: Response) => {
  const gate = await requireOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const ready = asaasConfigured();
  const balance = await getClubLedgerBalance(gate.userId);
  const depositPercent = Number(gate.profile.booking_deposit_percent) || 30;

  res.json({
    payments_ready: ready,
    provider: 'asaas',
    wagoo_fee_percent: WAGOO_APPLICATION_FEE_PERCENT,
    hold_minutes: BOOKING_PAYMENT_HOLD_MINUTES,
    ledger_balance_brl: balance,
    payout_pix_key: gate.profile.club_payout_pix_key ?? null,
    payout_pix_key_type: gate.profile.club_payout_pix_key_type ?? null,
    deposit_enabled: Boolean(gate.profile.booking_deposit_enabled),
    deposit_percent: depositPercent,
    advance_pay_enabled: Boolean(gate.profile.booking_advance_pay_enabled),
    tip: ready
      ? 'Pagamentos ativos. Clientes pagam na conta Wagoo; o líquido cai no seu saldo para saque PIX.'
      : 'Pagamentos em configuração. Em breve você libera sinal e saque aqui.',
  });
});

router.get('/me/fee-preview', async (req: Request, res: Response) => {
  const gate = await requireOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const total = Math.max(0, Number(req.query.total_brl) || 100);
  const percent = Math.min(100, Math.max(1, Number(req.query.deposit_percent) || 30));
  const deposit = computeDepositBrl(total, percent);
  const { wagoo_fee_brl, net_brl } = clubNetFromGross(deposit);

  res.json({
    total_brl: total,
    deposit_brl: deposit,
    wagoo_fee_brl,
    shop_receives_brl: net_brl,
    wagoo: {
      percent: WAGOO_APPLICATION_FEE_PERCENT,
      fee_brl: wagoo_fee_brl,
      label: `Wagoo ${WAGOO_APPLICATION_FEE_PERCENT}%`,
    },
    note: `Do sinal de R$ ${deposit.toFixed(2)}, a Wagoo fica com ${WAGOO_APPLICATION_FEE_PERCENT}%. O restante entra no seu saldo para saque PIX.`,
    summary: `Wagoo ${WAGOO_APPLICATION_FEE_PERCENT}% · você recebe o líquido no saldo.`,
  });
});

router.patch('/me/deposit-settings', express.json(), async (req: Request, res: Response) => {
  const gate = await requireOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  if (!asaasConfigured()) {
    return res.status(503).json({ error: 'Pagamentos ainda em configuração.' });
  }

  const depositEnabled = Boolean(req.body?.deposit_enabled);
  let depositPercent = Number(req.body?.deposit_percent);
  if (!Number.isFinite(depositPercent)) depositPercent = 30;
  depositPercent = Math.min(100, Math.max(1, Math.round(depositPercent * 100) / 100));
  const advancePayEnabled = Boolean(req.body?.advance_pay_enabled) && !depositEnabled;

  const { error } = await supabase
    .from('profiles')
    .update({
      booking_deposit_enabled: depositEnabled,
      booking_deposit_percent: depositPercent,
      booking_advance_pay_enabled: advancePayEnabled,
    })
    .eq('id', gate.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({
    ok: true,
    deposit_enabled: depositEnabled,
    deposit_percent: depositPercent,
    advance_pay_enabled: advancePayEnabled,
  });
});

router.put('/me/payout-pix', express.json(), async (req: Request, res: Response) => {
  const gate = await requireOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const rawKey = String(req.body?.pix_key ?? '').trim();
  const typeRaw = String(req.body?.pix_key_type ?? '').trim().toUpperCase();

  if (!rawKey) {
    await supabase
      .from('profiles')
      .update({ club_payout_pix_key: null, club_payout_pix_key_type: null })
      .eq('id', gate.userId);
    return res.json({ ok: true, payout_pix_key: null, payout_pix_key_type: null });
  }

  const allowed: PixKeyType[] = ['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP'];
  const type = (allowed.includes(typeRaw as PixKeyType)
    ? typeRaw
    : detectPixKeyType(rawKey)) as PixKeyType | null;
  if (!type) return res.status(400).json({ error: 'Tipo de chave PIX inválido.' });

  const normalized = normalizePixKey(rawKey, type);
  await supabase
    .from('profiles')
    .update({
      club_payout_pix_key: normalized,
      club_payout_pix_key_type: type,
    })
    .eq('id', gate.userId);

  res.json({ ok: true, payout_pix_key: normalized, payout_pix_key_type: type });
});

router.post('/me/payout', express.json(), async (req: Request, res: Response) => {
  const gate = await requireOwner(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  if (!asaasConfigured()) {
    return res.status(503).json({ error: 'Saques temporariamente indisponíveis.' });
  }

  const pixKey = String(gate.profile.club_payout_pix_key || '').trim();
  const pixType = String(gate.profile.club_payout_pix_key_type || '')
    .trim()
    .toUpperCase() as PixKeyType;
  if (!pixKey || !pixType) {
    return res.status(400).json({ error: 'Cadastre sua chave PIX antes de sacar.' });
  }

  const balance = await getClubLedgerBalance(gate.userId);
  const requested = Number(req.body?.amount_brl);
  const amount =
    Number.isFinite(requested) && requested > 0
      ? Math.round(requested * 100) / 100
      : balance;

  if (amount < 1) {
    return res.status(400).json({ error: 'Saldo insuficiente para saque (mín. R$ 1,00).' });
  }
  if (amount > balance + 0.001) {
    return res.status(400).json({
      error: `Saldo disponível: R$ ${balance.toFixed(2).replace('.', ',')}.`,
      ledger_balance_brl: balance,
    });
  }

  const transfer = await asaasTransferPix({
    value: amount,
    pixAddressKey: pixKey,
    pixAddressKeyType: pixType,
    description: 'Repasse Wagoo',
  });

  if (!transfer.ok) return res.status(502).json({ error: transfer.error });

  const debited = await debitClubLedgerForPayout({
    profileId: gate.userId,
    amountBrl: amount,
    asaasTransferId: transfer.data.id,
    description: 'Saque PIX',
  });

  if (!debited.ok) {
    log.error('PAY', 'transfer ok mas ledger debit falhou', null, {
      transferId: transfer.data.id,
    });
    return res.status(500).json({
      error: 'Transferência enviada, mas falhou o registro interno. Contate o suporte.',
      transfer_id: transfer.data.id,
    });
  }

  const newBalance = await getClubLedgerBalance(gate.userId);
  res.json({
    ok: true,
    amount_brl: amount,
    transfer_id: transfer.data.id,
    ledger_balance_brl: newBalance,
    message: `Saque de R$ ${amount.toFixed(2).replace('.', ',')} enviado para sua chave PIX.`,
  });
});

export default router;
