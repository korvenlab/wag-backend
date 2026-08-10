/**
 * Cliente HTTP Asaas (conta plataforma Wagoo).
 * Docs: https://docs.asaas.com
 */
import { log } from './logger';

const DEFAULT_API = 'https://api.asaas.com/v3';

export function asaasConfigured(): boolean {
  return Boolean(String(process.env.ASAAS_API_KEY || '').trim());
}

export function asaasBaseUrl(): string {
  const raw = String(process.env.ASAAS_API_URL || DEFAULT_API).trim().replace(/\/+$/, '');
  return raw || DEFAULT_API;
}

export type AsaasCustomer = {
  id: string;
  name?: string;
  email?: string | null;
  cpfCnpj?: string | null;
  mobilePhone?: string | null;
  externalReference?: string | null;
};

export type AsaasSubscription = {
  id: string;
  customer: string;
  value: number;
  cycle?: string;
  billingType?: string;
  status?: string;
  nextDueDate?: string;
  paymentLink?: string | null;
  externalReference?: string | null;
  description?: string | null;
};

export type AsaasPayment = {
  id: string;
  customer?: string;
  subscription?: string | null;
  value: number;
  netValue?: number;
  status?: string;
  billingType?: string;
  invoiceUrl?: string | null;
  bankSlipUrl?: string | null;
  externalReference?: string | null;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  dueDate?: string | null;
};

export type AsaasTransfer = {
  id: string;
  value: number;
  status?: string;
  dateCreated?: string;
};

type AsaasErrorBody = {
  errors?: { code?: string; description?: string }[];
  message?: string;
};

async function asaasRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const apiKey = String(process.env.ASAAS_API_KEY || '').trim();
  if (!apiKey) {
    return { ok: false, status: 503, error: 'Asaas não configurado (ASAAS_API_KEY).' };
  }

  const url = `${asaasBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        access_token: apiKey,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      const errBody = json as AsaasErrorBody | null;
      const fromList = errBody?.errors?.map((e) => e.description).filter(Boolean).join('; ');
      const error =
        fromList ||
        errBody?.message ||
        (typeof text === 'string' && text.slice(0, 200)) ||
        `Asaas HTTP ${res.status}`;
      log.warn('ASAAS', `${method} ${path} falhou`, { status: res.status, error });
      return { ok: false, status: res.status, error };
    }

    return { ok: true, data: json as T };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro de rede Asaas';
    log.error('ASAAS', `${method} ${path} rede`, err);
    return { ok: false, status: 502, error: message };
  }
}

export async function asaasCreateCustomer(input: {
  name: string;
  email?: string | null;
  mobilePhone?: string | null;
  cpfCnpj?: string | null;
  externalReference?: string;
}): Promise<{ ok: true; data: AsaasCustomer } | { ok: false; error: string }> {
  const phone = String(input.mobilePhone || '').replace(/\D/g, '');
  const payload: Record<string, unknown> = {
    name: input.name.slice(0, 100),
    externalReference: input.externalReference || undefined,
  };
  if (input.email) payload.email = input.email;
  if (phone.length >= 10) payload.mobilePhone = phone.slice(-11);
  if (input.cpfCnpj) payload.cpfCnpj = String(input.cpfCnpj).replace(/\D/g, '');

  const res = await asaasRequest<AsaasCustomer>('POST', '/customers', payload);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, data: res.data };
}

export async function asaasCreateSubscription(input: {
  customerId: string;
  value: number;
  nextDueDate: string; // YYYY-MM-DD
  description: string;
  externalReference: string;
  cycle?: 'MONTHLY' | 'WEEKLY' | 'YEARLY';
}): Promise<{ ok: true; data: AsaasSubscription } | { ok: false; error: string }> {
  const res = await asaasRequest<AsaasSubscription>('POST', '/subscriptions', {
    customer: input.customerId,
    billingType: 'UNDEFINED', // cliente escolhe Pix/boleto/cartão na fatura
    value: Math.round(Number(input.value) * 100) / 100,
    nextDueDate: input.nextDueDate,
    cycle: input.cycle || 'MONTHLY',
    description: input.description.slice(0, 500),
    externalReference: input.externalReference.slice(0, 100),
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, data: res.data };
}

export async function asaasListSubscriptionPayments(
  subscriptionId: string,
): Promise<{ ok: true; data: AsaasPayment[] } | { ok: false; error: string }> {
  const res = await asaasRequest<{ data?: AsaasPayment[] }>(
    'GET',
    `/subscriptions/${encodeURIComponent(subscriptionId)}/payments?limit=10`,
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, data: res.data?.data || [] };
}

export async function asaasGetPayment(
  paymentId: string,
): Promise<{ ok: true; data: AsaasPayment } | { ok: false; error: string }> {
  const res = await asaasRequest<AsaasPayment>(
    'GET',
    `/payments/${encodeURIComponent(paymentId)}`,
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, data: res.data };
}

export async function asaasCreatePayment(input: {
  customerId: string;
  value: number;
  dueDate: string;
  description: string;
  externalReference: string;
}): Promise<{ ok: true; data: AsaasPayment } | { ok: false; error: string }> {
  const res = await asaasRequest<AsaasPayment>('POST', '/payments', {
    customer: input.customerId,
    billingType: 'UNDEFINED',
    value: Math.round(Number(input.value) * 100) / 100,
    dueDate: input.dueDate,
    description: input.description.slice(0, 500),
    externalReference: input.externalReference.slice(0, 100),
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, data: res.data };
}

export async function asaasCancelSubscription(
  subscriptionId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await asaasRequest<unknown>(
    'DELETE',
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}

/** PIX para chave de outra instituição (repasse ao salão). */
export async function asaasTransferPix(input: {
  value: number;
  pixAddressKey: string;
  pixAddressKeyType: 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP';
  description?: string;
}): Promise<{ ok: true; data: AsaasTransfer } | { ok: false; error: string }> {
  const res = await asaasRequest<AsaasTransfer>('POST', '/transfers', {
    value: Math.round(Number(input.value) * 100) / 100,
    pixAddressKey: input.pixAddressKey,
    pixAddressKeyType: input.pixAddressKeyType,
    description: (input.description || 'Repasse Wagoo Clube').slice(0, 140),
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, data: res.data };
}

export function todayIsoDateSaoPaulo(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
