import { log } from './logger';
import {
  WAGOO_APPLICATION_FEE_PERCENT,
  computeApplicationFeeCents,
  centsToBrl,
  brlToCents,
} from './connectFees';

const MP_API = 'https://api.mercadopago.com';

export function mpClientId(): string {
  return (process.env.MP_CLIENT_ID || '').trim();
}

export function mpClientSecret(): string {
  return (process.env.MP_CLIENT_SECRET || '').trim();
}

export function mpPlatformAccessToken(): string {
  return (
    process.env.MP_ACCESS_TOKEN?.trim() ||
    process.env.MERCADOPAGO_ACCESS_TOKEN?.trim() ||
    ''
  );
}

export function mpPlatformPublicKey(): string {
  return (process.env.MP_PUBLIC_KEY || '').trim();
}

export function mpOAuthRedirectUri(): string {
  return (
    process.env.MP_OAUTH_REDIRECT_URI?.trim() ||
    'https://wag-backend.onrender.com/api/mercadopago/oauth/callback'
  );
}

export function mpOAuthAuthorizeUrl(state: string): string {
  const clientId = mpClientId();
  const redirect = encodeURIComponent(mpOAuthRedirectUri());
  const st = encodeURIComponent(state);
  return `https://auth.mercadopago.com.br/authorization?client_id=${clientId}&response_type=code&platform_id=mp&state=${st}&redirect_uri=${redirect}`;
}

export type MpOAuthTokenResponse = {
  access_token: string;
  public_key?: string;
  refresh_token?: string;
  live_mode?: boolean;
  user_id?: number | string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

export async function exchangeMpAuthorizationCode(
  code: string,
): Promise<MpOAuthTokenResponse> {
  const body = new URLSearchParams({
    client_id: mpClientId(),
    client_secret: mpClientSecret(),
    grant_type: 'authorization_code',
    code,
    redirect_uri: mpOAuthRedirectUri(),
  });
  const res = await fetch(`${MP_API}/oauth/token`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const json = (await res.json()) as MpOAuthTokenResponse & { message?: string; error?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(json.message || json.error || `oauth_token HTTP ${res.status}`);
  }
  return json;
}

export async function refreshMpAccessToken(
  refreshToken: string,
): Promise<MpOAuthTokenResponse> {
  const body = new URLSearchParams({
    client_id: mpClientId(),
    client_secret: mpClientSecret(),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch(`${MP_API}/oauth/token`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const json = (await res.json()) as MpOAuthTokenResponse & { message?: string; error?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(json.message || json.error || `refresh_token HTTP ${res.status}`);
  }
  return json;
}

export async function mpApiFetch<T = Record<string, unknown>>(
  path: string,
  opts: {
    accessToken: string;
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
  },
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.accessToken}`,
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (opts.idempotencyKey) headers['X-Idempotency-Key'] = opts.idempotencyKey;

  const res = await fetch(`${MP_API}${path}`, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T & {
    message?: string;
    error?: string;
    cause?: unknown;
  };
  if (!res.ok) {
    const detail =
      typeof json.message === 'string'
        ? json.message
        : typeof json.error === 'string'
        ? json.error
        : `MP HTTP ${res.status}`;
    log.warn('MP_API', detail, { path, status: res.status, cause: json.cause });
    throw new Error(detail);
  }
  return json;
}

/** application_fee / marketplace_fee em BRL (unidade da API MP, não centavos). */
export function wagooMarketplaceFeeBrl(amountBrl: number): number {
  const cents = computeApplicationFeeCents(brlToCents(amountBrl));
  return centsToBrl(cents);
}

export { WAGOO_APPLICATION_FEE_PERCENT, computeApplicationFeeCents, brlToCents, centsToBrl };

export type CreateMpPaymentInput = {
  sellerAccessToken: string;
  amountBrl: number;
  description: string;
  externalReference: string;
  metadata: Record<string, string>;
  payerEmail?: string | null;
  payerFirstName?: string | null;
  payerIdentification?: { type?: string; number?: string } | null;
  /** PIX: omit token. Cartão: token do Brick. */
  paymentMethodId?: string;
  token?: string;
  installments?: number;
  issuerId?: string | number | null;
  idempotencyKey: string;
  /** formData cru do Payment/CardPayment Brick */
  brickFormData?: Record<string, unknown> | null;
};

export async function createMpMarketplacePayment(
  input: CreateMpPaymentInput,
): Promise<Record<string, unknown>> {
  const amount = Math.round(Number(input.amountBrl) * 100) / 100;
  const fee = wagooMarketplaceFeeBrl(amount);
  const brick = input.brickFormData || {};

  const brickPayer =
    brick.payer && typeof brick.payer === 'object' && !Array.isArray(brick.payer)
      ? (brick.payer as Record<string, unknown>)
      : {};
  const brickId =
    brickPayer.identification &&
    typeof brickPayer.identification === 'object' &&
    !Array.isArray(brickPayer.identification)
      ? (brickPayer.identification as Record<string, unknown>)
      : input.payerIdentification || {};

  const token =
    (typeof brick.token === 'string' && brick.token) ||
    input.token ||
    undefined;
  const paymentMethodId =
    (typeof brick.payment_method_id === 'string' && brick.payment_method_id) ||
    input.paymentMethodId ||
    (token ? undefined : 'pix');
  const installments =
    Number(brick.installments) || Number(input.installments) || 1;
  const issuerId =
    brick.issuer_id != null && brick.issuer_id !== ''
      ? brick.issuer_id
      : input.issuerId;

  const email =
    (typeof brickPayer.email === 'string' && brickPayer.email.trim()) ||
    input.payerEmail?.trim() ||
    'cliente@wagoobot.com';

  const payer: Record<string, unknown> = {
    email,
    ...(input.payerFirstName
      ? { first_name: input.payerFirstName.slice(0, 60) }
      : {}),
  };
  if (brickId.type && brickId.number) {
    payer.identification = {
      type: String(brickId.type),
      number: String(brickId.number).replace(/\D/g, ''),
    };
  }

  const body: Record<string, unknown> = {
    transaction_amount: amount,
    description: input.description.slice(0, 250),
    external_reference: input.externalReference.slice(0, 256),
    metadata: input.metadata,
    application_fee: fee,
    binary_mode: true,
    payer,
  };

  if (token) {
    body.token = token;
    body.installments = Math.max(1, installments);
    if (paymentMethodId) body.payment_method_id = paymentMethodId;
    if (issuerId != null && issuerId !== '') {
      body.issuer_id = Number(issuerId);
    }
  } else {
    body.payment_method_id = paymentMethodId || 'pix';
  }

  return mpApiFetch('/v1/payments', {
    accessToken: input.sellerAccessToken,
    method: 'POST',
    body,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function getMpPayment(
  paymentId: string,
  accessToken: string,
): Promise<Record<string, unknown>> {
  return mpApiFetch(`/v1/payments/${paymentId}`, { accessToken });
}

export async function createMpPreapprovalPlan(opts: {
  sellerAccessToken: string;
  reason: string;
  amountBrl: number;
  backUrl: string;
}): Promise<Record<string, unknown>> {
  const amount = Math.round(Number(opts.amountBrl) * 100) / 100;
  return mpApiFetch('/preapproval_plan', {
    accessToken: opts.sellerAccessToken,
    method: 'POST',
    body: {
      reason: opts.reason.slice(0, 250),
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: amount,
        currency_id: 'BRL',
      },
      payment_methods_allowed: {
        payment_types: [{ id: 'credit_card' }, { id: 'debit_card' }],
        payment_methods: [],
      },
      back_url: opts.backUrl,
    },
    idempotencyKey: `plan-${Buffer.from(opts.reason).toString('base64url').slice(0, 24)}-${amount}`,
  });
}

export async function createMpPreapproval(opts: {
  sellerAccessToken: string;
  planId: string;
  reason: string;
  payerEmail: string;
  cardTokenId: string;
  externalReference: string;
  backUrl: string;
  amountBrl: number;
  idempotencyKey?: string;
}): Promise<{ preapproval: Record<string, unknown>; feeApplied: boolean }> {
  const amount = Math.round(Number(opts.amountBrl) * 100) / 100;
  const fee = wagooMarketplaceFeeBrl(amount);
  const idemBase =
    opts.idempotencyKey ||
    `preapproval-${opts.externalReference.replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 64)}`;

  const baseBody: Record<string, unknown> = {
    preapproval_plan_id: opts.planId,
    reason: opts.reason.slice(0, 250),
    external_reference: opts.externalReference.slice(0, 256),
    payer_email: opts.payerEmail.trim(),
    card_token_id: opts.cardTokenId,
    auto_recurring: {
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: amount,
      currency_id: 'BRL',
    },
    back_url: opts.backUrl,
    status: 'authorized',
  };

  // 1) application_fee (marketplace)
  try {
    const preapproval = await mpApiFetch('/preapproval', {
      accessToken: opts.sellerAccessToken,
      method: 'POST',
      body: { ...baseBody, application_fee: fee },
      idempotencyKey: `${idemBase}-fee`,
    });
    return { preapproval, feeApplied: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn('MP_API', 'preapproval com application_fee rejeitado; tentando marketplace_fee', {
      msg,
    });
  }

  // 2) marketplace_fee (alias em alguns fluxos)
  try {
    const preapproval = await mpApiFetch('/preapproval', {
      accessToken: opts.sellerAccessToken,
      method: 'POST',
      body: { ...baseBody, marketplace_fee: fee },
      idempotencyKey: `${idemBase}-mktfee`,
    });
    return { preapproval, feeApplied: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(
      'MP_API',
      'preapproval sem taxa Wagoo — API rejeitou fee; assinatura criada sem application_fee',
      { msg, externalReference: opts.externalReference, fee },
    );
  }

  // 3) Sem fee (último recurso — marca feeApplied=false para ops)
  const preapproval = await mpApiFetch('/preapproval', {
    accessToken: opts.sellerAccessToken,
    method: 'POST',
    body: baseBody,
    idempotencyKey: `${idemBase}-nofee`,
  });
  return { preapproval, feeApplied: false };
}

export async function getMpPreapproval(
  preapprovalId: string,
  accessToken: string,
): Promise<Record<string, unknown>> {
  return mpApiFetch(`/preapproval/${preapprovalId}`, { accessToken });
}

/** Cancela assinatura recorrente (status=cancelled). */
export async function cancelMpPreapproval(
  preapprovalId: string,
  accessToken: string,
): Promise<Record<string, unknown>> {
  return mpApiFetch(`/preapproval/${preapprovalId}`, {
    accessToken,
    method: 'PUT',
    body: { status: 'cancelled' },
    idempotencyKey: `cancel-preapproval-${preapprovalId}`,
  });
}

/** Pausa assinatura (status=paused). */
export async function pauseMpPreapproval(
  preapprovalId: string,
  accessToken: string,
): Promise<Record<string, unknown>> {
  return mpApiFetch(`/preapproval/${preapprovalId}`, {
    accessToken,
    method: 'PUT',
    body: { status: 'paused' },
    idempotencyKey: `pause-preapproval-${preapprovalId}`,
  });
}
