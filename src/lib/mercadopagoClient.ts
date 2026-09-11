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
  /** PIX: omit token. Cartão: token do Brick. */
  paymentMethodId?: string;
  token?: string;
  installments?: number;
  issuerId?: string | number | null;
  idempotencyKey: string;
};

export async function createMpMarketplacePayment(
  input: CreateMpPaymentInput,
): Promise<Record<string, unknown>> {
  const amount = Math.round(Number(input.amountBrl) * 100) / 100;
  const fee = wagooMarketplaceFeeBrl(amount);
  const body: Record<string, unknown> = {
    transaction_amount: amount,
    description: input.description.slice(0, 250),
    external_reference: input.externalReference.slice(0, 256),
    metadata: input.metadata,
    application_fee: fee,
    binary_mode: true,
    payer: {
      email: input.payerEmail?.trim() || 'cliente@wagoobot.com',
      ...(input.payerFirstName
        ? { first_name: input.payerFirstName.slice(0, 60) }
        : {}),
    },
  };

  if (input.token) {
    body.token = input.token;
    body.installments = Math.max(1, Number(input.installments) || 1);
    if (input.paymentMethodId) body.payment_method_id = input.paymentMethodId;
    if (input.issuerId != null && input.issuerId !== '') {
      body.issuer_id = Number(input.issuerId);
    }
  } else {
    body.payment_method_id = input.paymentMethodId || 'pix';
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
