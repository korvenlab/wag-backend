import express, { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  MP_WEBHOOK_MAX_SKEW_SEC,
  verifyMercadoPagoWebhookSignature,
} from '../lib/mercadopagoWebhook';
import {
  cancelMpPreapproval,
  createMpMarketplacePayment,
  createMpPreapproval,
  createMpPreapprovalPlan,
  exchangeMpAuthorizationCode,
  getMpPayment,
  getMpPreapproval,
  mpClientId,
  mpOAuthAuthorizeUrl,
  mpPlatformAccessToken,
  mpPlatformPublicKey,
  refreshMpAccessToken,
} from '../lib/mercadopagoClient';
import { decryptMpSecret, encryptMpSecret } from '../lib/mpTokenCrypto';
import { clientIp, isRateLimited } from '../lib/mpRateLimit';
import { frontendBaseUrl } from '../lib/stripeClient';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { supabase } from '../lib/supabase';
import { log } from '../lib/logger';
import { pushAdminEvent } from '../services/adminEvents';
import { publishControlPlaneEvent } from '../services/controlPlanePublisher';
import { fulfillBookingDepositPayment, markBookingPaymentFailed } from '../services/bookingPayments';
import {
  BOOKING_PAYMENT_HOLD_MINUTES,
  WAGOO_APPLICATION_FEE_PERCENT,
  FEE_COPY,
  buildFeeSchedulePayload,
  computeDepositBrl,
} from '../lib/connectFees';

const router = express.Router();

const PREAPPROVAL_OK = new Set(['authorized', 'approved', 'active', 'pending']);
const PREAPPROVAL_BAD = new Set(['cancelled', 'canceled', 'paused']);

type MpWebhookBody = {
  id?: number | string;
  live_mode?: boolean;
  type?: string;
  topic?: string;
  action?: string;
  data?: { id?: string | number };
};

function headerStr(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v[0]) return v[0];
  return undefined;
}

function extractDataId(req: Request, body: MpWebhookBody): string | undefined {
  const fromQuery = req.query['data.id'] ?? req.query.id;
  if (typeof fromQuery === 'string' && fromQuery.trim()) return fromQuery.trim();
  if (Array.isArray(fromQuery) && typeof fromQuery[0] === 'string') return fromQuery[0].trim();
  if (body.data?.id != null) return String(body.data.id);
  return undefined;
}

function extractTopic(req: Request, body: MpWebhookBody): string {
  const q = req.query.topic ?? req.query.type;
  if (typeof q === 'string' && q.trim()) return q.trim();
  return String(body.type || body.topic || body.action || 'unknown');
}

function oauthStateSecret(): string {
  return (
    process.env.MP_OAUTH_STATE_SECRET?.trim() ||
    process.env.MP_CLIENT_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    'wagoo-mp-oauth'
  );
}

function createMpOAuthState(userId: string): string {
  const exp = Math.floor(Date.now() / 1000) + 900;
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp }), 'utf8').toString('base64url');
  const sig = createHmac('sha256', oauthStateSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyMpOAuthState(state: unknown): { ok: true; userId: string } | { ok: false } {
  if (typeof state !== 'string' || !state.includes('.')) return { ok: false };
  const [payload, sig] = state.split('.', 2);
  if (!payload || !sig) return { ok: false };
  const expected = createHmac('sha256', oauthStateSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: string;
      exp?: number;
    };
    if (!data.sub || !data.exp || data.exp < Math.floor(Date.now() / 1000)) return { ok: false };
    return { ok: true, userId: data.sub };
  } catch {
    return { ok: false };
  }
}

async function loadSellerTokens(profileId: string): Promise<{
  accessToken: string;
  publicKey: string | null;
  userId: string;
} | null> {
  const { data } = await supabase
    .from('profiles')
    .select('mp_user_id, mp_access_token, mp_refresh_token, mp_public_key, mp_token_expires_at')
    .eq('id', profileId)
    .maybeSingle();
  if (!data?.mp_access_token || !data.mp_user_id) return null;

  let accessToken: string;
  let refreshToken: string | null = null;
  try {
    accessToken = decryptMpSecret(String(data.mp_access_token)) || '';
    refreshToken = data.mp_refresh_token
      ? decryptMpSecret(String(data.mp_refresh_token))
      : null;
  } catch (e) {
    log.error('MP_OAUTH', 'falha ao descriptografar tokens', {
      profileId,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
  if (!accessToken) return null;

  let publicKey = data.mp_public_key ? String(data.mp_public_key) : null;
  const expiresAt = data.mp_token_expires_at ? new Date(String(data.mp_token_expires_at)).getTime() : 0;
  const needsRefresh =
    Boolean(refreshToken) && expiresAt > 0 && expiresAt < Date.now() + 60_000;

  if (needsRefresh && refreshToken) {
    try {
      const refreshed = await refreshMpAccessToken(refreshToken);
      accessToken = refreshed.access_token;
      publicKey = refreshed.public_key || publicKey;
      const patch: Record<string, unknown> = {
        mp_access_token: encryptMpSecret(refreshed.access_token),
        mp_refresh_token: encryptMpSecret(
          refreshed.refresh_token || refreshToken,
        ),
        mp_public_key: publicKey,
      };
      if (refreshed.expires_in) {
        patch.mp_token_expires_at = new Date(
          Date.now() + Number(refreshed.expires_in) * 1000,
        ).toISOString();
      }
      await supabase.from('profiles').update(patch).eq('id', profileId);
    } catch (e) {
      log.warn('MP_OAUTH', 'refresh falhou; usando token atual', {
        profileId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { accessToken, publicKey, userId: String(data.mp_user_id) };
}

function metadataFromPayment(payment: Record<string, unknown>): Record<string, string> {
  const raw = payment.metadata;
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v == null) continue;
    out[k] = String(v);
  }
  return out;
}

async function activateClubMemberFromMp(opts: {
  memberId: string;
  paymentId?: string | null;
  preapprovalId?: string | null;
  amountBrl?: number | null;
  feeApplied?: boolean | null;
}): Promise<void> {
  const periodStart = new Date();
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);
  const patch: Record<string, unknown> = {
    status: 'active',
    current_period_start: periodStart.toISOString(),
    current_period_end: periodEnd.toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (opts.paymentId) patch.mp_payment_id = opts.paymentId;
  if (opts.preapprovalId) patch.mp_preapproval_id = opts.preapprovalId;
  if (opts.feeApplied != null) patch.mp_fee_applied = opts.feeApplied;
  await supabase.from('club_members').update(patch).eq('id', opts.memberId);
}

async function setClubMemberStatusFromMp(opts: {
  memberId: string;
  status: 'past_due' | 'canceled' | 'paused' | 'active';
  preapprovalId?: string | null;
}): Promise<void> {
  const patch: Record<string, unknown> = {
    status: opts.status === 'paused' ? 'past_due' : opts.status,
    updated_at: new Date().toISOString(),
  };
  if (opts.preapprovalId) patch.mp_preapproval_id = opts.preapprovalId;
  await supabase.from('club_members').update(patch).eq('id', opts.memberId);
}

function extractBrickFormData(body: Record<string, unknown>): Record<string, unknown> | null {
  if (body.formData && typeof body.formData === 'object' && !Array.isArray(body.formData)) {
    return body.formData as Record<string, unknown>;
  }
  // Brick às vezes envia o payload direto
  if (typeof body.token === 'string' || body.payment_method_id) {
    return body;
  }
  return null;
}

async function claimWebhookEvent(opts: {
  topic: string;
  dataId: string;
  action?: string | null;
  liveMode?: boolean;
  payload?: unknown;
}): Promise<boolean> {
  const { error } = await supabase.from('mp_webhook_events').insert({
    topic: opts.topic.slice(0, 120),
    data_id: opts.dataId.slice(0, 120),
    action: opts.action || null,
    live_mode: opts.liveMode ?? null,
    payload: opts.payload ?? null,
  });
  if (error) {
    // unique violation → já processado
    if (String(error.code) === '23505' || /duplicate|unique/i.test(error.message || '')) {
      return false;
    }
    log.warn('MP_WEBHOOK', 'falha ao registrar evento (seguindo mesmo assim)', {
      error: error.message,
    });
  }
  return true;
}

/** Status + vínculo MP do salão (substitui Connect para sinal/clube). */
router.get('/status', async (req: Request, res: Response) => {
  const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
  if (!auth.ok) {
    return res.status(401).json({ error: 'Faça login.' });
  }
  const { data: profile } = await supabase
    .from('profiles')
    .select(
      'mp_user_id, mp_public_key, mp_linked_at, booking_deposit_enabled, booking_deposit_percent, booking_advance_pay_enabled',
    )
    .eq('id', auth.user.id)
    .maybeSingle();

  const ready = Boolean(profile?.mp_user_id);
  res.json({
    provider: 'mercadopago',
    connected: ready,
    mp_user_id: profile?.mp_user_id || null,
    public_key: profile?.mp_public_key || mpPlatformPublicKey() || null,
    linked_at: profile?.mp_linked_at || null,
    ready_to_charge: ready,
    deposit_enabled: Boolean(profile?.booking_deposit_enabled),
    deposit_percent: Number(profile?.booking_deposit_percent) || 30,
    advance_pay_enabled: Boolean(profile?.booking_advance_pay_enabled),
    wagoo_fee_percent: WAGOO_APPLICATION_FEE_PERCENT,
    hold_minutes: BOOKING_PAYMENT_HOLD_MINUTES,
    tip: ready
      ? 'Mercado Pago vinculado. Clientes pagam sinal/clube na tela Wagoo (PIX ou cartão).'
      : 'Vincule sua conta Mercado Pago para receber sinais e mensalidades do clube.',
    fees: {
      wagoo_percent: WAGOO_APPLICATION_FEE_PERCENT,
      summary: FEE_COPY.summary,
    },
    oauth_configured: Boolean(mpClientId()),
  });
});

router.get('/oauth/start', async (req: Request, res: Response) => {
  const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
  if (!auth.ok) return res.status(401).json({ error: 'Faça login.' });
  if (!mpClientId()) {
    return res.status(503).json({ error: 'MP_CLIENT_ID não configurado no servidor.' });
  }
  const state = createMpOAuthState(auth.user.id);
  const url = mpOAuthAuthorizeUrl(state);
  res.json({ url });
});

router.get('/oauth/callback', async (req: Request, res: Response) => {
  const front = frontendBaseUrl();
  const fail = (msg: string) =>
    res.redirect(
      `${front}/dashboard/agenda-web?section=pagamentos&mp=error&reason=${encodeURIComponent(msg)}`,
    );

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = req.query.state;
  if (!code) return fail('Código OAuth ausente');
  const verified = verifyMpOAuthState(state);
  if (!verified.ok) return fail('State OAuth inválido ou expirado');

  try {
    const tokens = await exchangeMpAuthorizationCode(code);
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString()
      : null;
    const { error } = await supabase
      .from('profiles')
      .update({
        mp_user_id: tokens.user_id != null ? String(tokens.user_id) : null,
        mp_access_token: encryptMpSecret(tokens.access_token),
        mp_refresh_token: encryptMpSecret(tokens.refresh_token || null),
        mp_public_key: tokens.public_key || null,
        mp_token_expires_at: expiresAt,
        mp_linked_at: new Date().toISOString(),
      })
      .eq('id', verified.userId);
    if (error) return fail(error.message);
    pushAdminEvent('wagoo', `MP vinculado (user ${tokens.user_id})`, 'online');
    return res.redirect(`${front}/dashboard/agenda-web?section=pagamentos&mp=connected`);
  } catch (e) {
    log.error('MP_OAUTH', 'callback falhou', e);
    return fail(e instanceof Error ? e.message : 'Falha OAuth');
  }
});

router.post('/disconnect', async (req: Request, res: Response) => {
  const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
  if (!auth.ok) return res.status(401).json({ error: 'Faça login.' });
  await supabase
    .from('profiles')
    .update({
      mp_user_id: null,
      mp_access_token: null,
      mp_refresh_token: null,
      mp_public_key: null,
      mp_token_expires_at: null,
      mp_linked_at: null,
      booking_deposit_enabled: false,
      booking_advance_pay_enabled: false,
    })
    .eq('id', auth.user.id);
  res.json({ ok: true });
});

router.patch('/deposit-settings', async (req: Request, res: Response) => {
  const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
  if (!auth.ok) return res.status(401).json({ error: 'Faça login.' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('mp_user_id, mp_access_token')
    .eq('id', auth.user.id)
    .maybeSingle();
  const ready = Boolean(profile?.mp_user_id && profile?.mp_access_token);

  const patch: Record<string, unknown> = {};
  if (typeof req.body?.deposit_enabled === 'boolean') {
    if (req.body.deposit_enabled && !ready) {
      return res.status(400).json({ error: 'Vincule o Mercado Pago antes de exigir sinal.' });
    }
    patch.booking_deposit_enabled = req.body.deposit_enabled;
  }
  if (req.body?.deposit_percent != null) {
    const pct = Math.min(100, Math.max(1, Number(req.body.deposit_percent) || 30));
    patch.booking_deposit_percent = pct;
  }
  if (typeof req.body?.advance_pay_enabled === 'boolean') {
    if (req.body.advance_pay_enabled && !ready) {
      return res.status(400).json({ error: 'Vincule o Mercado Pago antes do pagamento adiantado.' });
    }
    patch.booking_advance_pay_enabled = req.body.advance_pay_enabled;
  }

  if (Object.keys(patch).length) {
    await supabase.from('profiles').update(patch).eq('id', auth.user.id);
  }

  const { data } = await supabase
    .from('profiles')
    .select(
      'booking_deposit_enabled, booking_deposit_percent, booking_advance_pay_enabled, mp_user_id',
    )
    .eq('id', auth.user.id)
    .maybeSingle();

  res.json({
    deposit_enabled: Boolean(data?.booking_deposit_enabled),
    deposit_percent: Number(data?.booking_deposit_percent) || 30,
    advance_pay_enabled: Boolean(data?.booking_advance_pay_enabled),
    ready_to_charge: Boolean(data?.mp_user_id),
  });
});

/** Preview de taxas (substitui /api/stripe/connect/fee-preview para sinal/clube). */
router.get('/fee-preview', async (req: Request, res: Response) => {
  const total = Number(req.query.total_brl ?? req.query.total ?? 0);
  const percent = Number(req.query.deposit_percent ?? 30);
  const deposit = computeDepositBrl(total, percent);
  res.json(buildFeeSchedulePayload(deposit));
});

/** Sessão pública para tela de pagamento do sinal. */
router.get(
  '/public/booking/:slug/appointments/:appointmentId',
  async (req: Request, res: Response) => {
    const slug = String(req.params.slug || '').trim();
    const appointmentId = String(req.params.appointmentId || '').trim();
    const { data: site } = await supabase
      .from('profiles')
      .select('id, store_name, booking_slug, mp_public_key, mp_user_id, mp_access_token')
      .eq('booking_slug', slug)
      .maybeSingle();
    if (!site?.mp_access_token) {
      return res.status(404).json({ error: 'Pagamento indisponível.' });
    }

    const { data: appt } = await supabase
      .from('booking_appointments')
      .select(
        'id, profile_id, client_name, starts_at, ends_at, status, payment_status, price_brl, deposit_amount_brl, payment_expires_at, mp_payment_id',
      )
      .eq('id', appointmentId)
      .eq('profile_id', site.id)
      .maybeSingle();

    if (!appt) return res.status(404).json({ error: 'Agendamento não encontrado.' });

    const depositBrl = Number(appt.deposit_amount_brl) || 0;
    res.json({
      store_name: site.store_name,
      slug: site.booking_slug,
      public_key: site.mp_public_key || mpPlatformPublicKey(),
      appointment: {
        id: appt.id,
        client_name: appt.client_name,
        starts_at: appt.starts_at,
        ends_at: appt.ends_at,
        status: appt.status,
        payment_status: appt.payment_status,
        price_brl: appt.price_brl,
        deposit_amount_brl: depositBrl,
        payment_expires_at: appt.payment_expires_at,
        paid: appt.payment_status === 'paid',
      },
      fees: buildFeeSchedulePayload(depositBrl),
      hold_minutes: BOOKING_PAYMENT_HOLD_MINUTES,
    });
  },
);

router.post(
  '/public/booking/:slug/appointments/:appointmentId/pay',
  async (req: Request, res: Response) => {
    const slug = String(req.params.slug || '').trim();
    const appointmentId = String(req.params.appointmentId || '').trim();
    if (isRateLimited(`mp-pay:${clientIp(req)}:${appointmentId}`, { limit: 12, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde um minuto.' });
    }
    const method = String(req.body?.method || 'pix').toLowerCase();
    const brickFormData = extractBrickFormData((req.body || {}) as Record<string, unknown>);

    const { data: site } = await supabase
      .from('profiles')
      .select('id, store_name, booking_slug, mp_user_id')
      .eq('booking_slug', slug)
      .maybeSingle();
    if (!site) return res.status(404).json({ error: 'Salão não encontrado.' });

    const seller = await loadSellerTokens(String(site.id));
    if (!seller) return res.status(400).json({ error: 'Mercado Pago não vinculado.' });

    const { data: appt } = await supabase
      .from('booking_appointments')
      .select(
        'id, profile_id, client_name, client_phone, status, payment_status, deposit_amount_brl, payment_expires_at',
      )
      .eq('id', appointmentId)
      .eq('profile_id', site.id)
      .maybeSingle();

    if (!appt) return res.status(404).json({ error: 'Agendamento não encontrado.' });
    if (appt.payment_status === 'paid') {
      return res.json({ already_paid: true, status: 'approved' });
    }
    if (appt.status === 'cancelled' || appt.payment_status === 'expired') {
      return res.status(400).json({ error: 'Pagamento expirado ou cancelado.' });
    }
    if (
      appt.payment_expires_at &&
      new Date(String(appt.payment_expires_at)).getTime() < Date.now()
    ) {
      await markBookingPaymentFailed(String(appt.id));
      return res.status(400).json({ error: 'Tempo para pagar esgotou.' });
    }

    const amountBrl = Number(appt.deposit_amount_brl) || 0;
    if (amountBrl <= 0) return res.status(400).json({ error: 'Valor inválido.' });

    const payerEmailFromBrick =
      brickFormData?.payer &&
      typeof brickFormData.payer === 'object' &&
      typeof (brickFormData.payer as { email?: string }).email === 'string'
        ? (brickFormData.payer as { email: string }).email
        : null;

    const meta = {
      product: 'wagoo',
      external_user_id: String(site.id),
      organization_id: String(site.id),
      plan: 'booking_deposit',
      kind: 'booking_deposit',
      wagoo_payment: 'booking_deposit',
      appointment_id: String(appt.id),
      profile_id: String(site.id),
      supabase_user_id: String(site.id),
      email: payerEmailFromBrick || '',
    };

    try {
      const payment = await createMpMarketplacePayment({
        sellerAccessToken: seller.accessToken,
        amountBrl,
        description: `Sinal — ${site.store_name || 'Wagoo'} · ${appt.client_name}`,
        externalReference: String(appt.id),
        metadata: meta,
        payerEmail:
          payerEmailFromBrick ||
          (typeof req.body?.payer_email === 'string' ? req.body.payer_email : null),
        payerFirstName: String(appt.client_name || '').split(/\s+/)[0] || null,
        paymentMethodId: method === 'pix' && !brickFormData ? 'pix' : undefined,
        token: method === 'pix' && !brickFormData ? undefined : undefined,
        brickFormData,
        installments: Number(req.body?.installments) || 1,
        issuerId: req.body?.issuer_id ?? null,
        idempotencyKey: `deposit-${appt.id}-${brickFormData ? 'brick' : method}`,
      });

      const paymentId = payment.id != null ? String(payment.id) : '';
      if (paymentId) {
        await supabase
          .from('booking_appointments')
          .update({ mp_payment_id: paymentId })
          .eq('id', appt.id);
      }

      const status = String(payment.status || '');
      if (status === 'approved') {
        await fulfillBookingDepositPayment({
          appointmentId: String(appt.id),
          mpPaymentId: paymentId,
        });
      }

      const poi = payment.point_of_interaction as
        | { transaction_data?: Record<string, unknown> }
        | undefined;
      const tx = poi?.transaction_data || {};

      return res.json({
        payment_id: paymentId,
        status,
        status_detail: payment.status_detail || null,
        qr_code: tx.qr_code || null,
        qr_code_base64: tx.qr_code_base64 || null,
        ticket_url: tx.ticket_url || null,
      });
    } catch (e) {
      log.error('MP_PAY', 'pagamento sinal falhou', e, { appointmentId });
      return res.status(502).json({
        error: e instanceof Error ? e.message : 'Falha ao criar pagamento.',
      });
    }
  },
);

/** Sessão pública clube. */
router.get('/public/club/:slug/members/:memberId', async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim();
  const memberId = String(req.params.memberId || '').trim();
  const { data: site } = await supabase
    .from('profiles')
    .select('id, store_name, booking_slug, mp_public_key, mp_access_token')
    .eq('booking_slug', slug)
    .maybeSingle();
  if (!site?.mp_access_token) return res.status(404).json({ error: 'Pagamento indisponível.' });

  const { data: member } = await supabase
    .from('club_members')
    .select('id, profile_id, client_name, client_phone, client_email, status, club_plan_id')
    .eq('id', memberId)
    .eq('profile_id', site.id)
    .maybeSingle();
  if (!member) return res.status(404).json({ error: 'Assinatura não encontrada.' });

  const { data: plan } = await supabase
    .from('club_plans')
    .select('id, name, description, price_brl, active')
    .eq('id', member.club_plan_id)
    .maybeSingle();

  const price = Number(plan?.price_brl) || 0;
  res.json({
    store_name: site.store_name,
    slug: site.booking_slug,
    public_key: site.mp_public_key || mpPlatformPublicKey(),
    member: {
      id: member.id,
      client_name: member.client_name,
      status: member.status,
      active: member.status === 'active',
    },
    plan: plan
      ? { id: plan.id, name: plan.name, description: plan.description, price_brl: price }
      : null,
    fees: buildFeeSchedulePayload(price),
  });
});

router.post('/public/club/:slug/members/:memberId/pay', async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim();
  const memberId = String(req.params.memberId || '').trim();
  if (isRateLimited(`mp-club-pay:${clientIp(req)}:${memberId}`, { limit: 12, windowMs: 60_000 })) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde um minuto.' });
  }
  const method = String(req.body?.method || 'pix').toLowerCase();
  const brickFormData = extractBrickFormData((req.body || {}) as Record<string, unknown>);

  const { data: site } = await supabase
    .from('profiles')
    .select('id, store_name, booking_slug')
    .eq('booking_slug', slug)
    .maybeSingle();
  if (!site) return res.status(404).json({ error: 'Salão não encontrado.' });

  const seller = await loadSellerTokens(String(site.id));
  if (!seller) return res.status(400).json({ error: 'Mercado Pago não vinculado.' });

  const { data: member } = await supabase
    .from('club_members')
    .select('id, profile_id, client_name, client_email, status, club_plan_id')
    .eq('id', memberId)
    .eq('profile_id', site.id)
    .maybeSingle();
  if (!member) return res.status(404).json({ error: 'Membro não encontrado.' });
  if (member.status === 'active') return res.json({ already_paid: true, status: 'approved' });

  const { data: plan } = await supabase
    .from('club_plans')
    .select('id, name, price_brl, mp_plan_id')
    .eq('id', member.club_plan_id)
    .maybeSingle();
  const amountBrl = Number(plan?.price_brl) || 0;
  if (amountBrl <= 0) return res.status(400).json({ error: 'Plano sem preço.' });

  const payerEmailFromBrick =
    brickFormData?.payer &&
    typeof brickFormData.payer === 'object' &&
    typeof (brickFormData.payer as { email?: string }).email === 'string'
      ? (brickFormData.payer as { email: string }).email
      : null;

  const meta = {
    product: 'wagoo',
    external_user_id: String(site.id),
    organization_id: String(site.id),
    plan: 'club_membership',
    kind: 'club_membership',
    wagoo_payment: 'club_membership',
    club_member_id: String(member.id),
    club_plan_id: String(plan?.id || ''),
    profile_id: String(site.id),
    supabase_user_id: String(site.id),
    email: payerEmailFromBrick || '',
  };

  try {
    const payment = await createMpMarketplacePayment({
      sellerAccessToken: seller.accessToken,
      amountBrl,
      description: `Clube — ${plan?.name || 'Wagoo'} · ${member.client_name}`,
      externalReference: `club:${member.id}`,
      metadata: meta,
      payerEmail:
        payerEmailFromBrick ||
        (typeof req.body?.payer_email === 'string' && req.body.payer_email) ||
        member.client_email ||
        null,
      payerFirstName: String(member.client_name || '').split(/\s+/)[0] || null,
      paymentMethodId: method === 'pix' && !brickFormData ? 'pix' : undefined,
      brickFormData,
      installments: Number(req.body?.installments) || 1,
      issuerId: req.body?.issuer_id ?? null,
      idempotencyKey: `club-${member.id}-${brickFormData ? 'brick' : method}`,
    });

    const paymentId = payment.id != null ? String(payment.id) : '';
    const status = String(payment.status || '');
    if (paymentId) {
      await supabase.from('club_members').update({ mp_payment_id: paymentId }).eq('id', member.id);
    }
    if (status === 'approved' && paymentId) {
      await activateClubMemberFromMp({ memberId: String(member.id), paymentId });
    }

    const poi = payment.point_of_interaction as
      | { transaction_data?: Record<string, unknown> }
      | undefined;
    const tx = poi?.transaction_data || {};
    return res.json({
      payment_id: paymentId,
      status,
      status_detail: payment.status_detail || null,
      qr_code: tx.qr_code || null,
      qr_code_base64: tx.qr_code_base64 || null,
      ticket_url: tx.ticket_url || null,
    });
  } catch (e) {
    log.error('MP_PAY', 'pagamento clube falhou', e, { memberId });
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Falha ao criar pagamento.',
    });
  }
});

/** Assinatura recorrente do clube (cartão → Preapproval mensal). */
router.post(
  '/public/club/:slug/members/:memberId/subscribe',
  async (req: Request, res: Response) => {
    const slug = String(req.params.slug || '').trim();
    const memberId = String(req.params.memberId || '').trim();
    if (isRateLimited(`mp-sub:${clientIp(req)}:${memberId}`, { limit: 8, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde um minuto.' });
    }
    const brickFormData = extractBrickFormData((req.body || {}) as Record<string, unknown>);
    const cardToken =
      (brickFormData && typeof brickFormData.token === 'string' && brickFormData.token) ||
      (typeof req.body?.token === 'string' ? req.body.token : '') ||
      (typeof req.body?.card_token_id === 'string' ? req.body.card_token_id : '');

    if (!cardToken) {
      return res.status(400).json({ error: 'Token do cartão ausente (Brick).' });
    }

    const { data: site } = await supabase
      .from('profiles')
      .select('id, store_name, booking_slug')
      .eq('booking_slug', slug)
      .maybeSingle();
    if (!site) return res.status(404).json({ error: 'Salão não encontrado.' });

    const seller = await loadSellerTokens(String(site.id));
    if (!seller) return res.status(400).json({ error: 'Mercado Pago não vinculado.' });

    const { data: member } = await supabase
      .from('club_members')
      .select('id, profile_id, client_name, client_email, status, club_plan_id, mp_preapproval_id')
      .eq('id', memberId)
      .eq('profile_id', site.id)
      .maybeSingle();
    if (!member) return res.status(404).json({ error: 'Membro não encontrado.' });
    if (member.status === 'active' && member.mp_preapproval_id) {
      return res.json({
        already_subscribed: true,
        status: 'authorized',
        preapproval_id: member.mp_preapproval_id,
      });
    }

    const { data: plan } = await supabase
      .from('club_plans')
      .select('id, name, price_brl, mp_plan_id')
      .eq('id', member.club_plan_id)
      .maybeSingle();
    const amountBrl = Number(plan?.price_brl) || 0;
    if (!plan || amountBrl <= 0) {
      return res.status(400).json({ error: 'Plano sem preço.' });
    }

    const payerEmail =
      (brickFormData?.payer &&
      typeof brickFormData.payer === 'object' &&
      typeof (brickFormData.payer as { email?: string }).email === 'string'
        ? (brickFormData.payer as { email: string }).email
        : null) ||
      (typeof req.body?.payer_email === 'string' ? req.body.payer_email : null) ||
      member.client_email ||
      'cliente@wagoobot.com';

    const backUrl = `${frontendBaseUrl()}/a/${encodeURIComponent(slug)}/cliente?checkout=success`;

    try {
      let planId = plan.mp_plan_id ? String(plan.mp_plan_id) : '';
      if (!planId) {
        const createdPlan = await createMpPreapprovalPlan({
          sellerAccessToken: seller.accessToken,
          reason: `${plan.name} · ${site.store_name || 'Wagoo'}`,
          amountBrl,
          backUrl,
        });
        planId = createdPlan.id != null ? String(createdPlan.id) : '';
        if (!planId) throw new Error('Falha ao criar plano recorrente no Mercado Pago.');
        await supabase.from('club_plans').update({ mp_plan_id: planId }).eq('id', plan.id);
      }

      const { preapproval, feeApplied } = await createMpPreapproval({
        sellerAccessToken: seller.accessToken,
        planId,
        reason: `${plan.name} · ${member.client_name}`,
        payerEmail: String(payerEmail),
        cardTokenId: cardToken,
        externalReference: `club:${member.id}`,
        backUrl,
        amountBrl,
        idempotencyKey: `preapproval-club-${member.id}`,
      });

      const preapprovalId = preapproval.id != null ? String(preapproval.id) : '';
      const status = String(preapproval.status || '').toLowerCase();
      if (!preapprovalId) throw new Error('Assinatura sem ID.');

      if (PREAPPROVAL_BAD.has(status)) {
        return res.status(402).json({
          error: 'Assinatura não autorizada pelo Mercado Pago.',
          status,
          preapproval_id: preapprovalId,
        });
      }

      if (!PREAPPROVAL_OK.has(status) && status) {
        // Guarda id mas não ativa até webhook confirmar
        await supabase
          .from('club_members')
          .update({
            mp_preapproval_id: preapprovalId,
            mp_fee_applied: feeApplied,
            status: 'pending',
            updated_at: new Date().toISOString(),
          })
          .eq('id', member.id);
        return res.json({
          preapproval_id: preapprovalId,
          status,
          recurring: true,
          pending: true,
          fee_applied: feeApplied,
        });
      }

      await activateClubMemberFromMp({
        memberId: String(member.id),
        preapprovalId,
        feeApplied,
      });

      if (!feeApplied) {
        pushAdminEvent(
          'wagoo',
          `Clube recorrente #${preapprovalId} SEM taxa Wagoo (API MP rejeitou fee)`,
          'degraded',
        );
      } else {
        pushAdminEvent(
          'wagoo',
          `Clube recorrente autorizado #${preapprovalId} · ${member.client_name}`,
          'online',
        );
      }

      return res.json({
        preapproval_id: preapprovalId,
        status: status || 'authorized',
        recurring: true,
        fee_applied: feeApplied,
      });
    } catch (e) {
      log.error('MP_SUB', 'assinatura clube falhou', e, { memberId });
      return res.status(502).json({
        error: e instanceof Error ? e.message : 'Falha ao criar assinatura recorrente.',
      });
    }
  },
);

/** Dono cancela assinatura recorrente de um membro. */
router.post('/members/:memberId/cancel', async (req: Request, res: Response) => {
  const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
  if (!auth.ok) return res.status(401).json({ error: 'Faça login.' });
  const memberId = String(req.params.memberId || '').trim();

  const { data: member } = await supabase
    .from('club_members')
    .select('id, profile_id, client_name, mp_preapproval_id, status')
    .eq('id', memberId)
    .eq('profile_id', auth.user.id)
    .maybeSingle();
  if (!member) return res.status(404).json({ error: 'Membro não encontrado.' });

  const seller = await loadSellerTokens(String(member.profile_id));
  if (member.mp_preapproval_id && seller) {
    try {
      await cancelMpPreapproval(String(member.mp_preapproval_id), seller.accessToken);
    } catch (e) {
      log.warn('MP_SUB', 'cancel preapproval falhou (seguindo local)', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  await setClubMemberStatusFromMp({
    memberId: String(member.id),
    status: 'canceled',
    preapprovalId: member.mp_preapproval_id ? String(member.mp_preapproval_id) : null,
  });
  pushAdminEvent('wagoo', `Clube cancelado · ${member.client_name}`, 'degraded');
  return res.json({ ok: true, status: 'canceled' });
});

/** Cliente cancela própria assinatura (telefone bate com o cadastro). */
router.post(
  '/public/club/:slug/members/:memberId/cancel',
  async (req: Request, res: Response) => {
    const slug = String(req.params.slug || '').trim();
    const memberId = String(req.params.memberId || '').trim();
    const phoneDigits = String(req.body?.phone || '')
      .replace(/\D/g, '')
      .slice(-11);
    if (phoneDigits.length < 10) {
      return res.status(400).json({ error: 'Informe o telefone cadastrado.' });
    }

    const { data: site } = await supabase
      .from('profiles')
      .select('id')
      .eq('booking_slug', slug)
      .maybeSingle();
    if (!site) return res.status(404).json({ error: 'Salão não encontrado.' });

    const { data: member } = await supabase
      .from('club_members')
      .select('id, profile_id, client_phone, mp_preapproval_id, status')
      .eq('id', memberId)
      .eq('profile_id', site.id)
      .maybeSingle();
    if (!member) return res.status(404).json({ error: 'Assinatura não encontrada.' });

    const memberPhone = String(member.client_phone || '')
      .replace(/\D/g, '')
      .slice(-11);
    if (!memberPhone || memberPhone !== phoneDigits) {
      return res.status(403).json({ error: 'Telefone não confere.' });
    }

    const seller = await loadSellerTokens(String(site.id));
    if (member.mp_preapproval_id && seller) {
      try {
        await cancelMpPreapproval(String(member.mp_preapproval_id), seller.accessToken);
      } catch (e) {
        log.warn('MP_SUB', 'cancel público falhou no MP', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    await setClubMemberStatusFromMp({
      memberId: String(member.id),
      status: 'canceled',
      preapprovalId: member.mp_preapproval_id ? String(member.mp_preapproval_id) : null,
    });
    return res.json({ ok: true, status: 'canceled' });
  },
);

/**
 * Webhooks Mercado Pago → fulfill sinal/clube + Korven control plane.
 */
router.post('/webhook', async (req: Request, res: Response) => {
  const secret = process.env.MP_WEBHOOK_SECRET?.trim();
  if (!secret) {
    log.error('MP_WEBHOOK', 'MP_WEBHOOK_SECRET não configurado');
    return res.status(503).json({ error: 'webhook_secret_missing' });
  }

  const body = (req.body || {}) as MpWebhookBody;
  const dataId = extractDataId(req, body);
  const topic = extractTopic(req, body);
  const okSig = verifyMercadoPagoWebhookSignature({
    xSignature: headerStr(req, 'x-signature'),
    xRequestId: headerStr(req, 'x-request-id'),
    dataId,
    secret,
    maxSkewSec: MP_WEBHOOK_MAX_SKEW_SEC,
  });
  if (!okSig) {
    log.warn('MP_WEBHOOK', 'assinatura inválida ou ts fora da janela', { topic, dataId });
    return res.status(401).json({ error: 'invalid_signature' });
  }

  res.status(200).json({ received: true });

  try {
    const liveMode = Boolean(body.live_mode);
    pushAdminEvent(
      'wagoo',
      `MP webhook: ${topic}${dataId ? ` #${dataId}` : ''}`,
      liveMode ? 'online' : 'degraded',
    );

    if (!dataId) return;

    const fresh = await claimWebhookEvent({
      topic,
      dataId,
      action: body.action ? String(body.action) : null,
      liveMode,
      payload: body,
    });
    if (!fresh) {
      log.info('MP_WEBHOOK', 'evento duplicado ignorado', { topic, dataId });
      return;
    }

    // Assinaturas / preapproval
    if (
      topic.includes('subscription') ||
      topic.includes('preapproval') ||
      topic === 'subscription_authorized_payment' ||
      topic === 'subscription_preapproval'
    ) {
      const { data: byPreapproval } = await supabase
        .from('club_members')
        .select('id, profile_id, mp_preapproval_id')
        .eq('mp_preapproval_id', dataId)
        .maybeSingle();

      let memberId = byPreapproval?.id ? String(byPreapproval.id) : null;
      let profileId = byPreapproval?.profile_id ? String(byPreapproval.profile_id) : null;
      let preapprovalStatus: string | null = null;

      if (!memberId) {
        // authorized payment id → buscar payment e external_reference club:
        const platformToken = mpPlatformAccessToken();
        let payment: Record<string, unknown> | null = null;
        if (platformToken) {
          try {
            payment = await getMpPayment(dataId, platformToken);
          } catch {
            payment = null;
          }
        }
        const ext =
          payment && typeof payment.external_reference === 'string'
            ? payment.external_reference
            : '';
        if (ext.startsWith('club:')) {
          memberId = ext.slice(5);
        }
        // Ou preapproval lookup
        if (!memberId && platformToken) {
          try {
            const pre = await getMpPreapproval(dataId, platformToken);
            preapprovalStatus = String(pre.status || '').toLowerCase();
            const pref =
              typeof pre.external_reference === 'string' ? pre.external_reference : '';
            if (pref.startsWith('club:')) memberId = pref.slice(5);
          } catch {
            /* ignore */
          }
        }
      } else {
        const seller = profileId ? await loadSellerTokens(profileId) : null;
        const token = seller?.accessToken || mpPlatformAccessToken();
        if (token) {
          try {
            const pre = await getMpPreapproval(dataId, token);
            preapprovalStatus = String(pre.status || '').toLowerCase();
          } catch {
            /* ignore */
          }
        }
      }

      if (memberId) {
        if (!profileId) {
          const { data: m } = await supabase
            .from('club_members')
            .select('profile_id')
            .eq('id', memberId)
            .maybeSingle();
          profileId = m?.profile_id ? String(m.profile_id) : null;
        }

        if (preapprovalStatus && PREAPPROVAL_BAD.has(preapprovalStatus)) {
          await setClubMemberStatusFromMp({
            memberId,
            status: preapprovalStatus === 'paused' ? 'paused' : 'canceled',
            preapprovalId: byPreapproval?.mp_preapproval_id
              ? String(byPreapproval.mp_preapproval_id)
              : dataId,
          });
          pushAdminEvent(
            'wagoo',
            `Clube ${preapprovalStatus} · membro ${memberId}`,
            'degraded',
          );
          return;
        }

        // Falha de cobrança autorizada (authorized_payment rejected)
        if (
          topic.includes('authorized_payment') &&
          body.action &&
          /reject|fail|cancel/i.test(String(body.action))
        ) {
          await setClubMemberStatusFromMp({
            memberId,
            status: 'past_due',
            preapprovalId: byPreapproval?.mp_preapproval_id
              ? String(byPreapproval.mp_preapproval_id)
              : null,
          });
          pushAdminEvent('wagoo', `Clube past_due · membro ${memberId}`, 'degraded');
          return;
        }

        await activateClubMemberFromMp({
          memberId,
          preapprovalId: byPreapproval?.mp_preapproval_id
            ? String(byPreapproval.mp_preapproval_id)
            : dataId,
          paymentId: topic.includes('authorized_payment') ? dataId : null,
        });
        pushAdminEvent('wagoo', `Clube renovado/autorizado · membro ${memberId}`, 'online');
        if (profileId) {
          void publishControlPlaneEvent({
            eventId: `mp:sub:${dataId}:${topic}`,
            eventType: 'payment.succeeded',
            externalUserId: profileId,
            organizationId: profileId,
            dedupeKey: `mp:sub:${dataId}`,
            payload: {
              provider: 'mercadopago',
              kind: 'club_membership',
              mercadopago_payment_id: dataId,
              plan: 'club_membership',
              metadata: {
                product: 'wagoo',
                external_user_id: profileId,
                kind: 'club_membership',
                recurring: true,
              },
            },
          });
        }
      }
      return;
    }

    if (!(topic === 'payment' || topic.includes('payment'))) return;

    const platformToken = mpPlatformAccessToken();
    let payment: Record<string, unknown> | null = null;
    if (platformToken) {
      try {
        payment = await getMpPayment(dataId, platformToken);
      } catch {
        payment = null;
      }
    }

    // Fallback: buscar pelo mp_payment_id no banco e usar token do salão
    if (!payment) {
      const { data: apptRow } = await supabase
        .from('booking_appointments')
        .select('profile_id')
        .eq('mp_payment_id', dataId)
        .maybeSingle();
      if (apptRow?.profile_id) {
        const seller = await loadSellerTokens(String(apptRow.profile_id));
        if (seller) payment = await getMpPayment(dataId, seller.accessToken);
      }
    }
    if (!payment) {
      const { data: memberRow } = await supabase
        .from('club_members')
        .select('profile_id')
        .eq('mp_payment_id', dataId)
        .maybeSingle();
      if (memberRow?.profile_id) {
        const seller = await loadSellerTokens(String(memberRow.profile_id));
        if (seller) payment = await getMpPayment(dataId, seller.accessToken);
      }
    }
    if (!payment) {
      log.warn('MP_WEBHOOK', 'não foi possível carregar payment', { dataId });
      return;
    }

    const status = String(payment.status || '');
    const meta = metadataFromPayment(payment);
    const kind = meta.wagoo_payment || meta.kind || '';
    const externalUserId =
      meta.external_user_id || meta.supabase_user_id || meta.profile_id || null;

    if (status === 'approved') {
      if (kind === 'booking_deposit' || meta.appointment_id) {
        const appointmentId =
          meta.appointment_id ||
          (typeof payment.external_reference === 'string' ? payment.external_reference : '');
        if (appointmentId) {
          await fulfillBookingDepositPayment({
            appointmentId,
            mpPaymentId: dataId,
          });
        }
      }
      if (kind === 'club_membership' || meta.club_member_id) {
        const memberId = meta.club_member_id;
        if (memberId) {
          await activateClubMemberFromMp({
            memberId,
            paymentId: dataId,
            amountBrl:
              typeof payment.transaction_amount === 'number'
                ? payment.transaction_amount
                : null,
          });
        }
      }
    } else if (
      status === 'rejected' ||
      status === 'cancelled' ||
      status === 'charged_back'
    ) {
      if (meta.appointment_id) {
        await markBookingPaymentFailed(meta.appointment_id);
      }
    }

    const amountReais =
      typeof payment.transaction_amount === 'number'
        ? payment.transaction_amount
        : Number(payment.transaction_amount);
    const amountCents = Number.isFinite(amountReais) ? Math.round(amountReais * 100) : null;
    const eventType =
      status === 'approved'
        ? 'payment.succeeded'
        : status === 'rejected' || status === 'cancelled' || status === 'charged_back'
        ? 'payment.failed'
        : null;

    if (eventType && externalUserId) {
      void publishControlPlaneEvent({
        eventId: `mp:${dataId}:${eventType}:${status}`,
        eventType,
        externalUserId,
        organizationId: meta.organization_id || undefined,
        email: meta.email || undefined,
        dedupeKey: `mp:payment:${dataId}:${eventType}`,
        payload: {
          provider: 'mercadopago',
          mercadopago_payment_id: dataId,
          mercadopago_status: status,
          livemode: liveMode,
          amount_total: amountCents,
          amount: Number.isFinite(amountReais) ? amountReais : null,
          currency: payment.currency_id ?? 'BRL',
          payment_method: payment.payment_method_id ?? null,
          application_fee: payment.application_fee ?? null,
          plan: meta.plan || null,
          kind: kind || 'mercadopago',
          metadata: {
            product: 'wagoo',
            external_user_id: externalUserId,
            organization_id: meta.organization_id || null,
            plan: meta.plan || null,
            kind: kind || null,
          },
        },
      });
    }
  } catch (e) {
    log.error('MP_WEBHOOK', 'falha ao processar', {
      error: e instanceof Error ? e.message : String(e),
      topic,
      dataId,
    });
  }
});

export default router;
