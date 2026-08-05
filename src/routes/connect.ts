import express, { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { stripe, frontendBaseUrl } from '../lib/stripeClient';
import {
  BOOKING_PAYMENT_HOLD_MINUTES,
  WAGOO_APPLICATION_FEE_PERCENT,
  STRIPE_PIX_FEE_PERCENT,
  STRIPE_CARD_FEE_PERCENT,
  STRIPE_CARD_FEE_FIXED_BRL,
  FEE_COPY,
  computeDepositBrl,
  buildFeeSchedulePayload,
} from '../lib/connectFees';
import { log } from '../lib/logger';

const router = Router();

type ConnectProfile = {
  stripe_connect_account_id: string | null;
  stripe_connect_charges_enabled: boolean;
  stripe_connect_payouts_enabled: boolean;
  stripe_connect_details_submitted: boolean;
  booking_deposit_enabled: boolean;
  booking_deposit_percent: number;
  booking_advance_pay_enabled: boolean;
  email?: string | null;
  store_name?: string | null;
};

async function requireUser(req: Request) {
  return getUserFromBearerHeader(supabase, req.headers.authorization);
}

async function loadConnectProfile(userId: string): Promise<ConnectProfile | null> {
  const { data } = await supabase
    .from('profiles')
    .select(
      'stripe_connect_account_id, stripe_connect_charges_enabled, stripe_connect_payouts_enabled, stripe_connect_details_submitted, booking_deposit_enabled, booking_deposit_percent, booking_advance_pay_enabled, store_name',
    )
    .eq('id', userId)
    .maybeSingle();
  return (data as ConnectProfile) ?? null;
}

export async function syncConnectAccountToProfile(
  userId: string,
  accountId: string,
): Promise<ConnectProfile | null> {
  try {
    const account = await stripe.accounts.retrieve(accountId);
    const patch = {
      stripe_connect_account_id: account.id,
      stripe_connect_charges_enabled: Boolean(account.charges_enabled),
      stripe_connect_payouts_enabled: Boolean(account.payouts_enabled),
      stripe_connect_details_submitted: Boolean(account.details_submitted),
    };
    await supabase.from('profiles').update(patch).eq('id', userId);
    return { ...(await loadConnectProfile(userId))!, ...patch };
  } catch (err) {
    log.error('CONNECT', 'sync account falhou', err, { userId, accountId });
    return null;
  }
}

/** Status + config de sinal para o painel do salão. */
router.get('/status', async (req: Request, res: Response) => {
  const auth = await requireUser(req);
  if (!auth.ok) {
    return res.status(401).json({
      error:
        auth.reason === 'missing_token'
          ? 'Faça login e envie Authorization: Bearer.'
          : 'Sessão inválida.',
    });
  }

  let profile = await loadConnectProfile(auth.user.id);
  if (!profile) return res.status(500).json({ error: 'Perfil não encontrado.' });

  if (profile.stripe_connect_account_id) {
    const synced = await syncConnectAccountToProfile(
      auth.user.id,
      profile.stripe_connect_account_id,
    );
    if (synced) profile = synced;
  }

  const ready =
    Boolean(profile.stripe_connect_account_id) &&
    Boolean(profile.stripe_connect_charges_enabled);

  res.json({
    connected: Boolean(profile.stripe_connect_account_id),
    account_id: profile.stripe_connect_account_id,
    charges_enabled: profile.stripe_connect_charges_enabled,
    payouts_enabled: profile.stripe_connect_payouts_enabled,
    details_submitted: profile.stripe_connect_details_submitted,
    ready_to_charge: ready,
    deposit_enabled: profile.booking_deposit_enabled,
    deposit_percent: Number(profile.booking_deposit_percent) || 30,
    advance_pay_enabled: Boolean(profile.booking_advance_pay_enabled),
    wagoo_fee_percent: WAGOO_APPLICATION_FEE_PERCENT,
    hold_minutes: BOOKING_PAYMENT_HOLD_MINUTES,
    fees: {
      wagoo_percent: WAGOO_APPLICATION_FEE_PERCENT,
      stripe_pix_percent: STRIPE_PIX_FEE_PERCENT,
      stripe_card_percent: STRIPE_CARD_FEE_PERCENT,
      stripe_card_fixed_brl: STRIPE_CARD_FEE_FIXED_BRL,
      summary: FEE_COPY.summary,
    },
    tip:
      !profile.stripe_connect_account_id
        ? 'Conecte sua conta para receber o dinheiro dos clientes.'
        : !ready
          ? 'Falta terminar o cadastro (documentos e conta bancária) para liberar os recebimentos.'
          : profile.booking_deposit_enabled
            ? 'Sinal ligado: o horário só confirma depois que o cliente pagar.'
            : profile.booking_advance_pay_enabled
              ? 'Sinal desligado; pagamento adiantado opcional ligado (cliente pode pagar 100% se quiser).'
              : 'Tudo pronto. Sinal e pagamento adiantado estão desligados — o cliente agenda sem pagar.',
  });
});

/** Saldo da conta Connect do salão (disponível + pendente). */
router.get('/balance', async (req: Request, res: Response) => {
  const auth = await requireUser(req);
  if (!auth.ok) {
    return res.status(401).json({
      error:
        auth.reason === 'missing_token'
          ? 'Faça login e envie Authorization: Bearer.'
          : 'Sessão inválida.',
    });
  }

  const profile = await loadConnectProfile(auth.user.id);
  if (!profile?.stripe_connect_account_id) {
    return res.status(400).json({
      error: 'Conecte a conta de recebimentos antes de ver o saldo.',
    });
  }

  try {
    const balance = await stripe.balance.retrieve({
      stripeAccount: profile.stripe_connect_account_id,
    });

    const sumBrl = (
      rows: Array<{ amount: number; currency: string }>,
    ): number =>
      rows
        .filter((r) => String(r.currency).toLowerCase() === 'brl')
        .reduce((acc, r) => acc + Number(r.amount || 0), 0) / 100;

    const available_brl = sumBrl(balance.available || []);
    const pending_brl = sumBrl(balance.pending || []);

    res.json({
      currency: 'brl',
      available_brl,
      pending_brl,
      total_brl: Math.round((available_brl + pending_brl) * 100) / 100,
      payouts_enabled: Boolean(profile.stripe_connect_payouts_enabled),
      charges_enabled: Boolean(profile.stripe_connect_charges_enabled),
    });
  } catch (error: unknown) {
    log.error('CONNECT', 'balance falhou', error, {
      accountId: profile.stripe_connect_account_id,
    });
    res.status(500).json({
      error: 'Não foi possível consultar o saldo agora. Tente de novo em instantes.',
    });
  }
});

/**
 * Transfere o saldo disponível da conta Connect para a conta bancária cadastrada.
 * Não abre o painel Stripe — o saque fica no Wagoo.
 */
router.post('/payout', express.json(), async (req: Request, res: Response) => {
  const auth = await requireUser(req);
  if (!auth.ok) {
    return res.status(401).json({ error: 'Faça login.' });
  }

  let profile = await loadConnectProfile(auth.user.id);
  if (!profile?.stripe_connect_account_id) {
    return res.status(400).json({
      error:
        'Primeiro cadastre sua conta de recebimentos. Sem esse cadastro não dá para ver saldo nem transferir.',
    });
  }

  const synced = await syncConnectAccountToProfile(
    auth.user.id,
    profile.stripe_connect_account_id,
  );
  if (synced) profile = synced;

  if (!profile.stripe_connect_payouts_enabled) {
    return res.status(400).json({
      error:
        'Termine o cadastro (documentos e conta bancária) para liberar transferências para o banco.',
    });
  }

  try {
    const balance = await stripe.balance.retrieve({
      stripeAccount: profile.stripe_connect_account_id,
    });
    const availableCents = (balance.available || [])
      .filter((r) => String(r.currency).toLowerCase() === 'brl')
      .reduce((acc, r) => acc + Number(r.amount || 0), 0);

    const requestedRaw = req.body?.amount_brl ?? req.body?.amountBrl;
    let amountCents = availableCents;
    if (requestedRaw !== undefined && requestedRaw !== null && requestedRaw !== '') {
      const brl = Number(requestedRaw);
      if (!Number.isFinite(brl) || brl <= 0) {
        return res.status(400).json({ error: 'Informe um valor válido para transferir.' });
      }
      amountCents = Math.round(brl * 100);
    }

    if (amountCents < 100) {
      return res.status(400).json({
        error: 'Valor mínimo para transferir: R$ 1,00. Aguarde ter saldo disponível.',
      });
    }
    if (amountCents > availableCents) {
      return res.status(400).json({
        error: 'O valor pedido é maior que o saldo disponível.',
        available_brl: availableCents / 100,
      });
    }

    const payout = await stripe.payouts.create(
      {
        amount: amountCents,
        currency: 'brl',
        metadata: {
          platform: 'wagoo',
          supabase_user_id: auth.user.id,
        },
      },
      { stripeAccount: profile.stripe_connect_account_id },
    );

    const remaining = await stripe.balance.retrieve({
      stripeAccount: profile.stripe_connect_account_id,
    });
    const sumBrl = (rows: Array<{ amount: number; currency: string }>) =>
      rows
        .filter((r) => String(r.currency).toLowerCase() === 'brl')
        .reduce((acc, r) => acc + Number(r.amount || 0), 0) / 100;

    res.json({
      ok: true,
      payout_id: payout.id,
      amount_brl: amountCents / 100,
      status: payout.status,
      arrival_date: payout.arrival_date
        ? new Date(payout.arrival_date * 1000).toISOString()
        : null,
      balance: {
        available_brl: sumBrl(remaining.available || []),
        pending_brl: sumBrl(remaining.pending || []),
        total_brl:
          Math.round(
            (sumBrl(remaining.available || []) + sumBrl(remaining.pending || [])) * 100,
          ) / 100,
        payouts_enabled: true,
        charges_enabled: Boolean(profile.stripe_connect_charges_enabled),
      },
      message: 'Transferência solicitada. O valor vai para a conta bancária cadastrada.',
    });
  } catch (error: unknown) {
    log.error('CONNECT', 'payout falhou', error, {
      accountId: profile.stripe_connect_account_id,
    });
    const stripeMsg =
      error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: string }).message || '')
        : '';
    const friendly =
      /external.?account|bank.?account|debit.?card/i.test(stripeMsg)
        ? 'Cadastre uma conta bancária no fluxo de recebimentos antes de transferir.'
        : /insufficient/i.test(stripeMsg)
          ? 'Saldo disponível insuficiente para essa transferência.'
          : 'Não foi possível transferir agora. Confira se o cadastro está completo e tente de novo.';
    res.status(500).json({ error: friendly });
  }
});

/**
 * Cria (se preciso) conta Express BR + Account Link de onboarding hospedado pela Stripe.
 * @see https://docs.stripe.com/connect/express-accounts
 * @see https://docs.stripe.com/connect/required-verification-information
 */
router.post('/onboard', express.json(), async (req: Request, res: Response) => {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) {
      return res.status(401).json({ error: 'Faça login.' });
    }

    const base = frontendBaseUrl();
    if (!base) return res.status(503).json({ error: 'FRONTEND_URL não configurada.' });

    const email = String(auth.user.email || '').trim().toLowerCase();
    let profile = await loadConnectProfile(auth.user.id);
    if (!profile) return res.status(500).json({ error: 'Perfil não encontrado.' });

    let accountId = profile.stripe_connect_account_id;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'BR',
        email: email || undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: {
          name: profile.store_name || undefined,
          product_description: 'Agendamentos e serviços locais via Wagoo Agenda Web',
          mcc: '7230', // Barber and beauty shops
        },
        metadata: {
          supabase_user_id: auth.user.id,
          platform: 'wagoo',
        },
      });
      accountId = account.id;
      await supabase
        .from('profiles')
        .update({
          stripe_connect_account_id: accountId,
          stripe_connect_charges_enabled: Boolean(account.charges_enabled),
          stripe_connect_payouts_enabled: Boolean(account.payouts_enabled),
          stripe_connect_details_submitted: Boolean(account.details_submitted),
        })
        .eq('id', auth.user.id);
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${base}/dashboard/agenda-web?connect=refresh`,
      return_url: `${base}/dashboard/agenda-web?connect=return`,
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url, account_id: accountId });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('CONNECT', 'onboard falhou', error);
    res.status(500).json({ error: message });
  }
});

/** Login Link → Express Dashboard (saldo, saques, disputas, dados).
 *  Se o onboarding não terminou, devolve o link de cadastro em vez de falhar. */
router.post('/dashboard', express.json(), async (req: Request, res: Response) => {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return res.status(401).json({ error: 'Faça login.' });

    const profile = await loadConnectProfile(auth.user.id);
    if (!profile?.stripe_connect_account_id) {
      return res.status(400).json({
        error: 'Conecte a conta de recebimentos primeiro.',
      });
    }

    const accountId = profile.stripe_connect_account_id;
    const base = frontendBaseUrl();
    if (!base) {
      return res.status(500).json({ error: 'FRONTEND_URL não configurada.' });
    }

    const needsOnboarding = !profile.stripe_connect_details_submitted;

    if (needsOnboarding) {
      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: `${base}/dashboard/agenda-web?connect=refresh`,
        return_url: `${base}/dashboard/agenda-web?connect=return`,
        type: 'account_onboarding',
      });
      return res.json({
        url: accountLink.url,
        onboarding: true,
      });
    }

    try {
      const login = await stripe.accounts.createLoginLink(accountId);
      return res.json({ url: login.url, onboarding: false });
    } catch (loginErr: unknown) {
      const loginMsg = loginErr instanceof Error ? loginErr.message : String(loginErr);
      // Conta criada mas onboarding incompleto no Stripe (flag local desatualizada)
      if (/not completed onboarding/i.test(loginMsg)) {
        const accountLink = await stripe.accountLinks.create({
          account: accountId,
          refresh_url: `${base}/dashboard/agenda-web?connect=refresh`,
          return_url: `${base}/dashboard/agenda-web?connect=return`,
          type: 'account_onboarding',
        });
        return res.json({
          url: accountLink.url,
          onboarding: true,
        });
      }
      throw loginErr;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('CONNECT', 'dashboard link falhou', error);
    res.status(500).json({
      error:
        /not completed onboarding/i.test(message)
          ? 'Termine o cadastro de recebimentos antes de abrir a conta bancária.'
          : message,
    });
  }
});

/** Atualiza % do sinal e liga/desliga cobrança no agendamento. */
router.patch('/deposit-settings', express.json(), async (req: Request, res: Response) => {
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(401).json({ error: 'Faça login.' });

  const profile = await loadConnectProfile(auth.user.id);
  if (!profile) return res.status(500).json({ error: 'Perfil não encontrado.' });

  const enabledRaw = req.body?.deposit_enabled ?? req.body?.depositEnabled;
  const percentRaw = req.body?.deposit_percent ?? req.body?.depositPercent;
  const advanceRaw = req.body?.advance_pay_enabled ?? req.body?.advancePayEnabled;

  const patch: Record<string, unknown> = {};

  if (enabledRaw !== undefined) {
    const enabled = Boolean(enabledRaw);
    if (enabled && !profile.stripe_connect_charges_enabled) {
      return res.status(400).json({
        error:
          'Conclua a verificação Stripe (cobranças liberadas) antes de ativar o sinal.',
      });
    }
    patch.booking_deposit_enabled = enabled;
  }

  if (percentRaw !== undefined) {
    const pct = Number(percentRaw);
    if (!Number.isFinite(pct) || pct < 1 || pct > 100) {
      return res.status(400).json({ error: 'Percentual do sinal deve ser entre 1 e 100.' });
    }
    patch.booking_deposit_percent = Math.round(pct * 100) / 100;
  }

  if (advanceRaw !== undefined) {
    const advance = Boolean(advanceRaw);
    if (advance && !profile.stripe_connect_charges_enabled) {
      return res.status(400).json({
        error:
          'Conclua a verificação Stripe (cobranças liberadas) antes de ativar o pagamento adiantado.',
      });
    }
    patch.booking_advance_pay_enabled = advance;
  }

  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'Nada para atualizar.' });
  }

  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', auth.user.id)
    .select(
      'booking_deposit_enabled, booking_deposit_percent, booking_advance_pay_enabled, stripe_connect_charges_enabled',
    )
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    deposit_enabled: data.booking_deposit_enabled,
    deposit_percent: Number(data.booking_deposit_percent),
    advance_pay_enabled: Boolean(data.booking_advance_pay_enabled),
    wagoo_fee_percent: WAGOO_APPLICATION_FEE_PERCENT,
    ready_to_charge: Boolean(data.stripe_connect_charges_enabled),
  });
});

/**
 * Preview de taxas para o painel.
 * Wagoo = 2% sempre; Stripe = Pix 1,19% ou cartão 3,99% + R$ 0,39.
 */
router.get('/fee-preview', async (req: Request, res: Response) => {
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(401).json({ error: 'Faça login.' });

  const profile = await loadConnectProfile(auth.user.id);
  const total = Math.max(0, Number(req.query.total_brl ?? req.query.total ?? 100));
  const percent = Number(
    req.query.deposit_percent ?? profile?.booking_deposit_percent ?? 30,
  );
  const deposit = computeDepositBrl(total, percent);
  const schedule = buildFeeSchedulePayload(deposit);

  res.json({
    total_brl: total,
    deposit_percent: percent,
    ...schedule,
    // Campos legados (compat) — líquido estimado via Pix (mais barato)
    wagoo_fee_percent: WAGOO_APPLICATION_FEE_PERCENT,
    wagoo_fee_brl: schedule.wagoo.fee_brl,
    shop_receives_brl: schedule.stripe.pix.shop_receives_brl,
    note: FEE_COPY.summary,
  });
});

export default router;
