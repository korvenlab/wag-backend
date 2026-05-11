import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { subDays, startOfDay, formatISO } from 'date-fns';
import { sessions } from '../services/whatsapp';
import { getAdminEvents, pushAdminEvent, AdminApp, AdminEventStatus } from '../services/adminEvents';
import { setProfileHasPaidByUserId } from '../lib/profileHasPaid';
import {
  complimentaryUntilToMillis,
  isComplimentaryAccessActive,
  profileHasWagooAccess,
  rowHasPaidTrue,
} from '../lib/profileAccess';
import { supabase } from '../lib/supabase';

dotenv.config();

const router = express.Router();

const stripeKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeKey ? new Stripe(stripeKey, { apiVersion: '2023-10-16' }) : null;

type ApiErrorCode =
  | 'UNAUTHORIZED'
  | 'VALIDATION_ERROR'
  | 'INTERNAL_ERROR'
  | 'UNAVAILABLE'
  | 'NOT_FOUND';

const JSON_UTF8 = 'application/json; charset=utf-8';

function sendApiError(
  res: Response,
  status: number,
  code: ApiErrorCode,
  error: string
): void {
  res.status(status).type(JSON_UTF8).json({ ok: false, error, code });
}

/** Alinhado a `feedback.ts`: Korven Console usa `WAGOO_METRICS_API_KEY` ↔ `METRICS_API_KEY` aqui. */
function getUpstreamSecret(): string {
  return (
    process.env.ADMIN_API_SECRET ||
    process.env.API_SECRET ||
    process.env.METRICS_API_KEY ||
    ''
  ).trim();
}

/** Nunca logar o valor retornado (segredo). */
function extractProvidedSecret(req: Request): string | undefined {
  const auth = req.headers.authorization;
  const bearer =
    typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')
      ? auth.slice(7).trim()
      : undefined;
  const apiKeyRaw = req.headers['x-api-key'];
  const apiKey = Array.isArray(apiKeyRaw) ? apiKeyRaw[0]?.trim() : apiKeyRaw?.trim();
  const legacyRaw = req.headers['x-admin-secret'];
  const legacy = Array.isArray(legacyRaw) ? legacyRaw[0]?.trim() : legacyRaw?.trim();
  const pick = bearer || apiKey || legacy;
  return pick && pick.length > 0 ? pick : undefined;
}

function requireUpstreamAuth(req: Request, res: Response, next: NextFunction): void {
  const configured = getUpstreamSecret();
  if (!configured) {
    sendApiError(
      res,
      500,
      'INTERNAL_ERROR',
      'Segredo API não configurado (ADMIN_API_SECRET, API_SECRET ou METRICS_API_KEY).'
    );
    return;
  }
  const provided = extractProvidedSecret(req);
  if (!provided || provided !== configured) {
    sendApiError(res, 401, 'UNAUTHORIZED', 'Não autorizado.');
    return;
  }
  next();
}

router.use(requireUpstreamAuth);

const ADMIN_WINDOW_MS = 60_000;
const ADMIN_WINDOW_MAX = 120;
const adminHits = new Map<string, { count: number; resetAt: number }>();

type AdminAuditRow = {
  actor: string;
  action: string;
  target: string;
  timestamp: string;
  meta?: Record<string, unknown>;
};

const adminAudit: AdminAuditRow[] = [];
const MAX_ADMIN_AUDIT = 500;

function getClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const fromHeader = Array.isArray(xff) ? xff[0] : xff;
  const ip = typeof fromHeader === 'string' ? fromHeader.split(',')[0]?.trim() : undefined;
  return ip || req.ip || 'unknown';
}

function getAdminActor(req: Request): string {
  const actor = req.headers['x-admin-actor'];
  if (Array.isArray(actor)) return actor[0] || 'admin:unknown';
  if (typeof actor === 'string' && actor.trim()) return actor.trim();
  return 'admin:unknown';
}

function pushAdminAudit(row: AdminAuditRow): void {
  adminAudit.unshift(row);
  if (adminAudit.length > MAX_ADMIN_AUDIT) adminAudit.length = MAX_ADMIN_AUDIT;
}

function adminRateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  const key = getClientIp(req);
  const prev = adminHits.get(key);
  if (!prev || now > prev.resetAt) {
    adminHits.set(key, { count: 1, resetAt: now + ADMIN_WINDOW_MS });
    next();
    return;
  }
  prev.count += 1;
  if (prev.count > ADMIN_WINDOW_MAX) {
    sendApiError(res, 429, 'UNAVAILABLE', 'Rate limit excedido para rotas admin.');
    return;
  }
  next();
}

router.use(adminRateLimit);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseOrganizationFilters(
  req: Request
):
  | { ok: true; organization_id: string | null; organization: string | null }
  | { ok: false; error: string } {
  const oidRaw =
    typeof req.query.organization_id === 'string' ? req.query.organization_id.trim() : '';
  const orgRaw =
    typeof req.query.organization === 'string' ? req.query.organization.trim() : '';

  let organization_id: string | null = null;
  let organization: string | null = null;

  if (oidRaw) {
    if (!UUID_RE.test(oidRaw)) return { ok: false, error: 'organization_id deve ser UUID válido.' };
    organization_id = oidRaw;
  }

  if (orgRaw) {
    if (UUID_RE.test(orgRaw)) {
      if (organization_id && organization_id !== orgRaw) {
        return { ok: false, error: 'organization e organization_id inconsistentes.' };
      }
      if (!organization_id) organization_id = orgRaw;
    } else {
      organization = orgRaw;
    }
  }

  return { ok: true, organization_id, organization };
}

function parsePeriodDaysParam(raw: unknown): { ok: true; value: number } | { ok: false } {
  const v =
    raw === undefined || raw === null || raw === '' ? 30 : Number(raw);
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1 || v > 366) return { ok: false };
  return { ok: true, value: v };
}

function parseChartDaysParam(
  raw: unknown,
  periodDays: number
): { ok: true; value: number } | { ok: false } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: Math.min(periodDays, 90) };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 90) return { ok: false };
  return { ok: true, value: n };
}

function pctChange(current: number, previous: number): number | null {
  if (previous <= 0) return current > 0 ? 100 : null;
  return ((current - previous) / previous) * 100;
}

const MAX_STRIPE_INVOICES_SCAN = 8000;

/** Faturas pagas cuja data de pagamento cai no intervalo (usa paid_at; faz paginação com limite de segurança). */
async function listPaidInvoicesByPaidAtRange(
  client: Stripe,
  startUnix: number,
  endUnix: number,
  onTruncated: () => void
): Promise<Stripe.Invoice[]> {
  const out: Stripe.Invoice[] = [];
  let starting_after: string | undefined;
  let scanned = 0;
  for (;;) {
    const page = await client.invoices.list({
      status: 'paid',
      limit: 100,
      starting_after,
    });
    for (const inv of page.data) {
      const paidAt = inv.status_transitions?.paid_at ?? inv.created;
      if (paidAt >= startUnix && paidAt <= endUnix) {
        out.push(inv);
      }
    }
    scanned += page.data.length;
    if (!page.has_more || page.data.length === 0) break;
    if (scanned >= MAX_STRIPE_INVOICES_SCAN) {
      onTruncated();
      break;
    }
    starting_after = page.data[page.data.length - 1].id;
  }
  return out;
}

function sumInvoiceAmountBrl(invoices: Stripe.Invoice[]): number {
  let cents = 0;
  for (const inv of invoices) {
    const cur = (inv.currency || 'brl').toLowerCase();
    if (cur !== 'brl') continue;
    cents += inv.amount_paid || 0;
  }
  return cents / 100;
}

function bucketByDayBrl(
  invoices: Stripe.Invoice[],
  days: number
): { date: string; amountBrl: number }[] {
  const orderedDates: string[] = [];
  const map = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    const d = startOfDay(subDays(new Date(), days - 1 - i));
    const key = formatISO(d, { representation: 'date' });
    orderedDates.push(key);
    map.set(key, 0);
  }
  for (const inv of invoices) {
    const cur = (inv.currency || 'brl').toLowerCase();
    if (cur !== 'brl') continue;
    const paidAt = inv.status_transitions?.paid_at ?? inv.created;
    const d = formatISO(startOfDay(new Date(paidAt * 1000)), { representation: 'date' });
    if (!map.has(d)) continue;
    map.set(d, (map.get(d) || 0) + (inv.amount_paid || 0) / 100);
  }
  return orderedDates.map((date) => ({ date, amountBrl: map.get(date) || 0 }));
}

function bucketDailyVolume(
  rows: { date: string; count: number }[],
  days: number
): { data: string; volume: number }[] {
  const orderedDates: string[] = [];
  const map = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    const d = startOfDay(subDays(new Date(), days - 1 - i));
    const key = formatISO(d, { representation: 'date' });
    orderedDates.push(key);
    map.set(key, 0);
  }
  for (const r of rows) {
    const k = String(r.date).slice(0, 10);
    if (!map.has(k)) continue;
    map.set(k, (map.get(k) || 0) + (Number(r.count) || 0));
  }
  return orderedDates.map((data) => ({ data, volume: map.get(data) || 0 }));
}

async function countActiveSubscriptions(client: Stripe): Promise<number> {
  let n = 0;
  let starting_after: string | undefined;
  for (;;) {
    const page = await client.subscriptions.list({
      status: 'active',
      limit: 100,
      starting_after,
    });
    n += page.data.length;
    if (!page.has_more || page.data.length === 0) break;
    starting_after = page.data[page.data.length - 1].id;
  }
  return n;
}

async function countSubscriptionsCreatedInRange(
  client: Stripe,
  startUnix: number,
  endUnix: number
): Promise<number> {
  let n = 0;
  let starting_after: string | undefined;
  for (;;) {
    const page = await client.subscriptions.list({
      created: { gte: startUnix, lte: endUnix },
      limit: 100,
      starting_after,
    });
    n += page.data.length;
    if (!page.has_more || page.data.length === 0) break;
    starting_after = page.data[page.data.length - 1].id;
  }
  return n;
}

async function fetchAuthUsersAll(): Promise<
  Array<{
    id: string;
    email?: string;
    created_at?: string;
    last_sign_in_at?: string | null;
    user_metadata?: Record<string, unknown>;
    app_metadata?: Record<string, unknown>;
    banned_until?: string | null;
  }>
> {
  const users: Array<{
    id: string;
    email?: string;
    created_at?: string;
    last_sign_in_at?: string | null;
    user_metadata?: Record<string, unknown>;
    app_metadata?: Record<string, unknown>;
    banned_until?: string | null;
  }> = [];
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const pageUsers = data?.users ?? [];
    const batch = pageUsers.map((u) => ({
      id: u.id,
      email: u.email ?? undefined,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at ?? null,
      user_metadata: (u.user_metadata || {}) as Record<string, unknown>,
      app_metadata: (u.app_metadata || {}) as Record<string, unknown>,
      banned_until: u.banned_until ?? null,
    }));
    users.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
  }
  return users;
}

/** Auth e `profiles.id` devem coincidir; normaliza para evitar falha de lookup por casing. */
function normalizeAuthUserId(id: string): string {
  return String(id || '').trim().toLowerCase();
}

function profileRowForUser(
  profileMap: Map<string, Record<string, unknown>>,
  authUserId: string,
): Record<string, unknown> | undefined {
  const key = normalizeAuthUserId(authUserId);
  return profileMap.get(key) ?? profileMap.get(authUserId.trim());
}

async function healthSupabase(): Promise<boolean> {
  const { error } = await supabase.from('profiles').select('id', { head: true, count: 'exact' }).limit(1);
  return !error;
}

async function health2Avendas(): Promise<AdminEventStatus> {
  const url = process.env.AVENDAS_HEALTH_URL?.trim();
  if (!url) return 'offline';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) return 'online';
    return 'degraded';
  } catch {
    return 'offline';
  }
}

/**
 * Conta linhas em `profiles` com o mesmo critério do app (`/api/user/profile` → `has_access`):
 * `has_paid` truthy (Stripe / normalização) OU `complimentary_access_until` ainda no futuro.
 * Pagina para não depender de limite PostgREST; ordem estável por `id`.
 */
async function countProfilesWithWagooAppAccess(client: SupabaseClient): Promise<number> {
  const pageSize = 1000;
  let from = 0;
  let n = 0;
  for (;;) {
    const { data, error } = await client
      .from('profiles')
      .select('has_paid, complimentary_access_until')
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data ?? [];
    if (!rows.length) break;
    for (const row of rows) {
      const r = row as { has_paid?: unknown; complimentary_access_until?: string | null };
      if (
        profileHasWagooAccess({
          has_paid: r.has_paid,
          complimentary_access_until: r.complimentary_access_until ?? undefined,
        })
      ) {
        n += 1;
      }
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return n;
}

function parseAvendasMetrics(): {
  volume: number;
  changePct: number | null;
  transactionsPerDay: { date: string; count: number }[];
  configured: boolean;
} {
  const raw = process.env.AVENDAS_TRANSACTIONS_JSON?.trim();
  const volumeEnv = process.env.AVENDAS_VOLUME_TOTAL?.trim();
  const changeEnv = process.env.AVENDAS_VOLUME_CHANGE_PCT?.trim();

  let transactionsPerDay: { date: string; count: number }[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        transactionsPerDay = parsed
          .map((row) => {
            if (row && typeof row === 'object' && 'date' in row && 'count' in row) {
              const r = row as { date: string; count: number };
              return { date: String(r.date), count: Number(r.count) || 0 };
            }
            return null;
          })
          .filter((x): x is { date: string; count: number } => x !== null);
      }
    } catch {
      transactionsPerDay = [];
    }
  }

  const configured = !!(raw || volumeEnv);
  const volume =
    volumeEnv !== undefined && volumeEnv !== ''
      ? Number(volumeEnv)
      : transactionsPerDay.reduce((s, d) => s + d.count, 0);

  const changePct =
    changeEnv !== undefined && changeEnv !== '' ? Number(changeEnv) : null;

  return { volume, changePct, transactionsPerDay, configured };
}

type AdminUserRow = {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  active: boolean;
  hasPaid: boolean;
  /** Acesso efetivo Wagoo (Stripe ou cortesia). */
  hasAccess: boolean;
  /** Igual a `hasAccess` (JSON snake_case). */
  has_access: boolean;
  complimentary_access_until?: string | null;
  /** True se existir linha em `wagoo_promo_redemptions` (já resgatou algum link alguma vez). */
  complimentaryViaLink?: boolean;
  /** Origem dos canais que **hoje** concedem acesso (resumo para a tabela Korven). */
  accessOriginSummary: string;
  /** Texto longo para tooltip: Stripe vs link vs base. */
  accessOriginDetail: string;
  createdAt: string;
  lastSignInAt: string | null;
};

type AdminUserRowCore = Omit<
  AdminUserRow,
  'complimentaryViaLink' | 'accessOriginSummary' | 'accessOriginDetail' | 'has_access'
>;

/** Explica canais que habilitam acesso (has_paid, cortesia por link, cortesia na base). */
function buildWagooAccessOriginPT(input: {
  hasAccess: boolean;
  hasPaid: boolean;
  complimentaryActive: boolean;
  hasPromoRedemption: boolean;
}): { accessOriginSummary: string; accessOriginDetail: string } {
  const { hasAccess, hasPaid, complimentaryActive, hasPromoRedemption } = input;

  if (!hasAccess) {
    return {
      accessOriginSummary: 'Sem acesso',
      accessOriginDetail:
        'Nenhum canal activo: profiles.has_paid inactivo e complimentary_access_until vazio ou já expirado.',
    };
  }

  const parts: string[] = [];
  if (hasPaid) parts.push('Assinatura (has_paid)');
  if (complimentaryActive) {
    parts.push(hasPromoRedemption ? 'Cortesia (link)' : 'Cortesia (base de dados)');
  }

  let accessOriginSummary = '—';
  if (parts.length === 2) accessOriginSummary = 'Assinatura + cortesia';
  else if (parts.length === 1) accessOriginSummary = parts[0]!;

  const detailBits: string[] = [];
  if (hasPaid) {
    detailBits.push(
      'Canal assinatura: profiles.has_paid activo (Stripe via webhook ou alteração directa no Postgres — não distinguimos aqui).',
    );
  }
  if (complimentaryActive) {
    if (hasPromoRedemption) {
      detailBits.push(
        'Canal cortesia: prazo activo em profiles.complimentary_access_until com resgate registado em wagoo_promo_redemptions (link / convite).',
      );
    } else {
      detailBits.push(
        'Canal cortesia: prazo activo em profiles.complimentary_access_until sem resgate de link (console Korven «Ajustar cortesia» ou SQL na base).',
      );
    }
  }
  if (!detailBits.length) {
    detailBits.push('Acesso activo; verifique profiles.has_paid e complimentary_access_until.');
  }

  return { accessOriginSummary, accessOriginDetail: detailBits.join(' ') };
}

/** Body JSON do PATCH has-paid: aceita hasPaid ou has_paid (boolean, número ou string). */
function parseHasPaidFromRequestBody(body: unknown): boolean | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const raw = b.hasPaid ?? b.has_paid;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw !== 0;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (['true', 't', '1', 'yes'].includes(s)) return true;
    if (['false', 'f', '0', 'no'].includes(s)) return false;
  }
  return null;
}

function normalizeAdminUser(
  authUser: {
    id: string;
    email?: string;
    created_at?: string;
    last_sign_in_at?: string;
    user_metadata?: Record<string, unknown>;
    app_metadata?: Record<string, unknown>;
    banned_until?: string | null;
  },
  profile?: {
    email?: string | null;
    store_name?: string | null;
    role?: string | null;
    is_active?: boolean | null;
    deleted_at?: string | null;
    has_paid?: unknown;
    complimentary_access_until?: unknown;
  }
): AdminUserRowCore {
  const role =
    (profile?.role as string | undefined) ||
    (authUser.app_metadata?.role as string | undefined) ||
    (authUser.user_metadata?.role as string | undefined) ||
    'user';

  const activeFromMeta = authUser.user_metadata?.active;
  const activeFromProfile = profile?.is_active;
  const isBanned = !!authUser.banned_until;
  const deleted = !!profile?.deleted_at || authUser.user_metadata?.deleted === true;

  const active =
    !isBanned &&
    !deleted &&
    (typeof activeFromProfile === 'boolean'
      ? activeFromProfile
      : typeof activeFromMeta === 'boolean'
        ? activeFromMeta
        : true);

  const hasPaid = rowHasPaidTrue(profile?.has_paid);
  const untilRaw = profile?.complimentary_access_until;
  const hasAccess = profileHasWagooAccess({
    has_paid: profile?.has_paid,
    complimentary_access_until: untilRaw,
  });
  const untilMs = complimentaryUntilToMillis(untilRaw);
  const complimentaryIso =
    untilMs != null && Number.isFinite(untilMs) ? new Date(untilMs).toISOString() : null;

  return {
    id: authUser.id,
    email: authUser.email ?? profile?.email ?? null,
    name:
      (authUser.user_metadata?.name as string | undefined) ||
      (profile?.store_name as string | undefined) ||
      null,
    role,
    active,
    hasPaid,
    hasAccess,
    complimentary_access_until: complimentaryIso ?? (typeof untilRaw === 'string' ? untilRaw.trim() || null : null),
    createdAt: authUser.created_at || new Date(0).toISOString(),
    lastSignInAt: authUser.last_sign_in_at || null,
  };
}

async function getUserIdsWithPromoRedemption(userIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!userIds.length) return out;
  const idsNorm = [...new Set(userIds.map((id) => normalizeAuthUserId(id)))];
  const { data, error } = await supabase
    .from('wagoo_promo_redemptions')
    .select('user_id')
    .in('user_id', idsNorm);
  if (error || !data) return out;
  for (const row of data as { user_id?: string }[]) {
    if (typeof row.user_id === 'string') out.add(normalizeAuthUserId(row.user_id));
  }
  return out;
}

function buildWagooAdminUserRow(
  authUser: {
    id: string;
    email?: string;
    created_at?: string;
    last_sign_in_at?: string;
    user_metadata?: Record<string, unknown>;
    app_metadata?: Record<string, unknown>;
    banned_until?: string | null;
  },
  profileMap: Map<string, Record<string, unknown>>,
  promoUserIds: Set<string>,
): AdminUserRow {
  const profile = profileRowForUser(profileMap, authUser.id) as
    | {
        email?: string | null;
        store_name?: string | null;
        role?: string | null;
        is_active?: boolean | null;
        deleted_at?: string | null;
        has_paid?: unknown;
        complimentary_access_until?: unknown;
      }
    | undefined;
  const base = normalizeAdminUser(authUser, profile);
  const hasPromoRedemption = promoUserIds.has(normalizeAuthUserId(authUser.id));
  const complimentaryActive = isComplimentaryAccessActive(base.complimentary_access_until ?? undefined);
  const { accessOriginSummary, accessOriginDetail } = buildWagooAccessOriginPT({
    hasAccess: base.hasAccess,
    hasPaid: base.hasPaid,
    complimentaryActive,
    hasPromoRedemption,
  });

  return {
    ...base,
    /** Alias snake_case para proxies / clientes que normalizam chaves JSON. */
    has_access: base.hasAccess,
    complimentaryViaLink: hasPromoRedemption,
    accessOriginSummary,
    accessOriginDetail,
  };
}

const PROFILE_ADMIN_SELECT =
  'id, email, store_name, role, is_active, deleted_at, has_paid, complimentary_access_until';

async function getUserProfileMap(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) return map;
  const idsNorm = [...new Set(ids.map((id) => normalizeAuthUserId(id)))];
  const { data, error } = await supabase.from('profiles').select(PROFILE_ADMIN_SELECT).in('id', idsNorm);
  if (data) {
    for (const row of data as unknown as Record<string, unknown>[]) {
      const rawId = row.id;
      const key =
        typeof rawId === 'string'
          ? normalizeAuthUserId(rawId)
          : rawId != null
            ? normalizeAuthUserId(String(rawId))
            : '';
      if (key) map.set(key, row);
    }
  }
  const missing = idsNorm.filter((id) => !map.has(id));
  if (!missing.length) return map;
  /** `.in()` por vezes omite linhas (URL longa, tipos, etc.); garante lookup por id como o `/api/user/profile`. */
  await Promise.all(
    missing.map(async (id) => {
      const { data: one, error: e2 } = await supabase
        .from('profiles')
        .select(PROFILE_ADMIN_SELECT)
        .eq('id', id)
        .maybeSingle();
      if (!e2 && one) {
        const row = one as Record<string, unknown>;
        map.set(id, row);
      }
    }),
  );
  return map;
}

router.get('/dashboard', async (req: Request, res: Response) => {
  try {
  const periodRaw = req.query.period_days ?? req.query.periodDays ?? req.query.period;
  const chartRaw = req.query.chart_days ?? req.query.chartDays;

  const parsedPeriod = parsePeriodDaysParam(periodRaw);
  if (!parsedPeriod.ok) {
    sendApiError(
      res,
      400,
      'VALIDATION_ERROR',
      'period_days deve ser inteiro entre 1 e 366.'
    );
    return;
  }
  const period_days = parsedPeriod.value;

  const parsedChart = parseChartDaysParam(chartRaw, period_days);
  if (!parsedChart.ok) {
    sendApiError(
      res,
      400,
      'VALIDATION_ERROR',
      'chart_days deve ser inteiro entre 1 e 90.'
    );
    return;
  }
  const chart_days = parsedChart.value;

  const parsedOrg = parseOrganizationFilters(req);
  if (!parsedOrg.ok) {
    sendApiError(res, 400, 'VALIDATION_ERROR', parsedOrg.error);
    return;
  }
  const { organization_id, organization: organization_label } = parsedOrg;

  const now = new Date();
  const nowUnix = Math.floor(now.getTime() / 1000);
  const periodStart = Math.floor(subDays(now, period_days).getTime() / 1000);
  const prevStart = Math.floor(subDays(now, period_days * 2).getTime() / 1000);
  const prevEnd = periodStart - 1;
  const chartStartUnix = Math.floor(startOfDay(subDays(now, chart_days - 1)).getTime() / 1000);

  const warnings: string[] = [];

  let profilesCount = 0;
  let payingProfiles = 0;
  let whatsappConfigured = 0;
  let profilesWithAppAccess = 0;

  try {
    const { count: totalProfiles, error: e1 } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true });
    if (e1) throw e1;
    profilesCount = totalProfiles ?? 0;

    const { count: paid, error: e2 } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('has_paid', true);
    if (e2) throw e2;
    payingProfiles = paid ?? 0;

    const { count: wa, error: e3 } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .not('whatsapp_session', 'is', null);
    if (e3) throw e3;
    whatsappConfigured = wa ?? 0;
  } catch (e: unknown) {
    warnings.push(`Supabase profiles: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    profilesWithAppAccess = await countProfilesWithWagooAppAccess(supabase);
  } catch (e: unknown) {
    warnings.push(
      `Contagem acesso app (profiles): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const botOnlineEmails = Object.keys(sessions).sort();

  let revenueCurrentPeriod = 0;
  let revenuePrevPeriod = 0;
  let revenuePerDay: { date: string; amountBrl: number }[] = [];
  let activeSubscriptions = 0;
  let newSubsCurrent = 0;
  let newSubsPrev = 0;

  if (!stripe) {
    warnings.push('Stripe não configurado (STRIPE_SECRET_KEY).');
  } else {
    try {
      const fetchStartUnix = Math.min(prevStart, chartStartUnix);
      const invWindow = await listPaidInvoicesByPaidAtRange(
        stripe,
        fetchStartUnix,
        nowUnix,
        () => warnings.push('Listagem Stripe truncada; totais de receita podem estar incompletos.')
      );
      const invCurrent = invWindow.filter((inv) => {
        const t = inv.status_transitions?.paid_at ?? inv.created;
        return t >= periodStart && t <= nowUnix;
      });
      const invPrev = invWindow.filter((inv) => {
        const t = inv.status_transitions?.paid_at ?? inv.created;
        return t >= prevStart && t <= prevEnd;
      });
      const invChart = invWindow.filter((inv) => {
        const t = inv.status_transitions?.paid_at ?? inv.created;
        return t >= chartStartUnix && t <= nowUnix;
      });
      revenueCurrentPeriod = sumInvoiceAmountBrl(invCurrent);
      revenuePrevPeriod = sumInvoiceAmountBrl(invPrev);
      revenuePerDay = bucketByDayBrl(invChart, chart_days);
      activeSubscriptions = await countActiveSubscriptions(stripe);
      newSubsCurrent = await countSubscriptionsCreatedInRange(stripe, periodStart, nowUnix);
      newSubsPrev = await countSubscriptionsCreatedInRange(stripe, prevStart, prevEnd);
    } catch (e: unknown) {
      warnings.push(`Stripe: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const avendas = parseAvendasMetrics();
  const volumePorDia2 = bucketDailyVolume(avendas.transactionsPerDay, chart_days);

  const coreOk = await healthSupabase();
  const wagooStatus: AdminEventStatus =
    botOnlineEmails.length > 0 ? 'online' : payingProfiles > 0 ? 'degraded' : 'offline';
  const coreStatus: AdminEventStatus = coreOk ? 'online' : 'offline';
  const avendasHealth = await health2Avendas();

  const statuses = [wagooStatus, coreStatus, avendasHealth];
  const weights: Record<AdminEventStatus, number> = { online: 100, degraded: 92, offline: 0 };
  const averageUptimePct =
    statuses.reduce((s, st) => s + weights[st], 0) / Math.max(statuses.length, 1);

  let authUsers: { id: string; email?: string; last_sign_in_at?: string | null }[] = [];
  try {
    authUsers = await fetchAuthUsersAll();
  } catch (e: unknown) {
    warnings.push(`Auth listUsers: ${e instanceof Error ? e.message : String(e)}`);
  }

  const recentSignIns = [...authUsers]
    .filter((u) => u.email)
    .sort((a, b) => {
      const ta = a.last_sign_in_at ? new Date(a.last_sign_in_at).getTime() : 0;
      const tb = b.last_sign_in_at ? new Date(b.last_sign_in_at).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 40)
    .map((u) => ({
      email: u.email as string,
      lastSignInAt: u.last_sign_in_at ?? null,
    }));

  const nowIso = new Date().toISOString();
  const eventos = getAdminEvents(80).map((e) => ({
    id: e.id,
    app: e.app,
    status: e.status,
    message: e.message,
    timestamp: e.timestamp,
  }));

  const kpis = {
    receita_total: {
      valor: revenueCurrentPeriod,
      delta_pct: pctChange(revenueCurrentPeriod, revenuePrevPeriod) ?? 0,
    },
    /** Alinhado ao app Wagoo: perfis com `has_paid` OU cortesia (`complimentary_access_until`) activa. */
    usuarios_acesso_app_wagoo: {
      valor: profilesWithAppAccess,
      delta_pct: 0,
    },
    assinaturas_ativas_wagoo: {
      valor: activeSubscriptions,
      delta_pct: pctChange(newSubsCurrent, newSubsPrev) ?? 0,
    },
    volume_vendas_2avendas: {
      valor: avendas.volume,
      delta_pct: avendas.changePct ?? 0,
    },
    uptime_medio: {
      valor: Math.round(averageUptimePct * 100) / 100,
      delta_pct: 0,
    },
  };

  const ui = {
    sidebar_itens: [
      { label: 'Visão Geral', href: '/', icon: 'layout-dashboard' },
      { label: 'Wagoo', href: '/wagoo', icon: 'message-circle' },
      { label: '2AVENDAS', href: '/2avendas', icon: 'shopping-cart' },
      { label: 'Configurações', href: '/settings', icon: 'settings' },
    ],
    topbar: {
      title: 'Korven Dashboard',
      subtitle: 'Upstream: Wagoo',
    },
  };

  res.status(200).type(JSON_UTF8).json({
    ok: true,
    gerado_em: nowIso,
    filtros: {
      organization_id,
      organization: organization_label,
      period_days,
      chart_days,
    },
    kpis,
    wagoo: {
      receita_por_dia: revenuePerDay.map((d) => ({
        data: d.date,
        receita: d.amountBrl,
      })),
    },
    dois_avendas: {
      volume_por_dia: volumePorDia2,
    },
    eventos_recentes: eventos,
    ui,
      legacy: {
        kpis: {
          salesVolume2avendas: {
            value: avendas.volume,
            changePct: avendas.changePct,
          },
        },
        wagoo: {
          activeSubscriptions,
          profilesWithAppAccess,
          registeredProfiles: profilesCount,
          payingUsersInDb: payingProfiles,
          whatsappConfiguredProfiles: whatsappConfigured,
          botSessionsOnline: botOnlineEmails.length,
        },
      sales2avendas: {
        volume: avendas.volume,
        changePct: avendas.changePct,
        transactionsPerDay: avendas.transactionsPerDay,
        configured: avendas.configured,
      },
      users: {
        totalAuthUsers: authUsers.length,
        totalProfiles: profilesCount,
        payingCount: payingProfiles,
        botOnlineEmails,
        recentSignIns,
      },
      appsHealth: [
        { app: 'wagoo' as const, status: wagooStatus },
        { app: 'core' as const, status: coreStatus },
        { app: '2avendas' as const, status: avendasHealth },
      ],
      warnings,
    },
  });
  } catch (e: unknown) {
    sendApiError(
      res,
      500,
      'INTERNAL_ERROR',
      e instanceof Error ? e.message : 'Erro ao montar dashboard.'
    );
  }
});

/** Korven / ferramentas: lista valores distintos de `profiles.role` (evita 404 em GET /api/admin/roles). */
router.get('/roles', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase.from('profiles').select('role');
    if (error) throw error;
    const seen = new Set<string>();
    for (const row of (data ?? []) as { role?: string | null }[]) {
      const v = typeof row.role === 'string' ? row.role.trim() : '';
      if (v) seen.add(v);
    }
    const items = [...seen]
      .sort((a, b) => a.localeCompare(b))
      .map((value) => ({ value, label: value }));
    res.status(200).type(JSON_UTF8).json({ ok: true, data: { items } });
  } catch (e: unknown) {
    sendApiError(res, 500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
});

router.get('/users', async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';

  try {
    const authUsers = await fetchAuthUsersAll();
    let filtered = authUsers;
    if (search) {
      filtered = authUsers.filter((u) => {
        const email = (u.email || '').toLowerCase();
        return email.includes(search) || u.id.toLowerCase().includes(search);
      });
    }

    const total = filtered.length;
    const start = (page - 1) * limit;
    const pageUsers = filtered.slice(start, start + limit);
    const profileMap = await getUserProfileMap(pageUsers.map((u) => u.id));
    const promoUserIds = await getUserIdsWithPromoRedemption(pageUsers.map((u) => u.id));

    const items = pageUsers.map((u) =>
      buildWagooAdminUserRow(
        u as unknown as {
          id: string;
          email?: string;
          created_at?: string;
          last_sign_in_at?: string;
          user_metadata?: Record<string, unknown>;
          app_metadata?: Record<string, unknown>;
          banned_until?: string | null;
        },
        profileMap,
        promoUserIds,
      ),
    );

    res.status(200).type(JSON_UTF8).json({
      ok: true,
      data: { items, page, limit, total },
    });
  } catch (e: unknown) {
    sendApiError(res, 500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
});

router.get('/users/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id || '').trim();
  if (!id) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'id é obrigatório.');
    return;
  }
  try {
    const { data, error } = await supabase.auth.admin.getUserById(id);
    if (error || !data?.user) {
      sendApiError(res, 404, 'NOT_FOUND', 'Usuário não encontrado.');
      return;
    }
    const profileMap = await getUserProfileMap([id]);
    const promoUserIds = await getUserIdsWithPromoRedemption([id]);
    const user = buildWagooAdminUserRow(
      data.user as unknown as {
        id: string;
        email?: string;
        created_at?: string;
        last_sign_in_at?: string;
        user_metadata?: Record<string, unknown>;
        app_metadata?: Record<string, unknown>;
        banned_until?: string | null;
      },
      profileMap,
      promoUserIds,
    );
    res.status(200).type(JSON_UTF8).json({ ok: true, data: user });
  } catch (e: unknown) {
    sendApiError(res, 500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
});

/** Korven: altera assinatura manual (`has_paid`), espelhando webhook (IA ligada só quando pago). */
router.patch('/users/:id/has-paid', async (req: Request, res: Response) => {
  const id = String(req.params.id || '').trim();
  const hasPaid = parseHasPaidFromRequestBody(req.body);
  if (!id || hasPaid === null) {
    sendApiError(
      res,
      400,
      'VALIDATION_ERROR',
      'id e hasPaid ou has_paid (valor booleano ou equivalente) são obrigatórios.',
    );
    return;
  }
  try {
    const paidResult = await setProfileHasPaidByUserId(supabase, id, hasPaid);
    if (!paidResult.ok) {
      const msg = paidResult.error;
      const low = msg.toLowerCase();
      const isAuthMissing =
        low.includes('not found') || low.includes('sem id') || low.includes('user not found');
      sendApiError(res, isAuthMissing ? 404 : 500, isAuthMissing ? 'NOT_FOUND' : 'INTERNAL_ERROR', msg);
      return;
    }

    const actor = getAdminActor(req);
    pushAdminAudit({
      actor,
      action: 'user.has_paid.update',
      target: id,
      timestamp: new Date().toISOString(),
      meta: { hasPaid },
    });
    pushAdminEvent(
      'core',
      `Admin ${hasPaid ? 'marcou como pago' : 'marcou como não pago'} (${id})`,
      hasPaid ? 'online' : 'degraded',
    );
    res.status(200).type(JSON_UTF8).json({ ok: true, data: { id, hasPaid } });
  } catch (e: unknown) {
    sendApiError(res, 500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
});

const COMPLIMENTARY_PRESETS = ['none', '7', '30', '60', '90', '180', '365'] as const;
type ComplimentaryPreset = (typeof COMPLIMENTARY_PRESETS)[number];

function parseComplimentaryPreset(body: unknown): ComplimentaryPreset | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as Record<string, unknown>).preset;
  if (raw === 'none' || raw === null) return 'none';
  if (typeof raw === 'string' && (COMPLIMENTARY_PRESETS as readonly string[]).includes(raw))
    return raw as ComplimentaryPreset;
  return null;
}

/** Korven: define cortesia administrativa (`complimentary_access_until`) sem alterar Stripe (`has_paid`). POST duplicado: alguns proxies bloqueiam PATCH. */
async function handleUserComplimentaryAccess(req: Request, res: Response): Promise<void> {
  const id = normalizeAuthUserId(String(req.params.id || ''));
  const preset = parseComplimentaryPreset(req.body);
  if (!id || preset === null) {
    sendApiError(
      res,
      400,
      'VALIDATION_ERROR',
      'preset obrigatório: none, 7, 30, 60, 90, 180, 365.',
    );
    return;
  }
  try {
    const auth = await supabase.auth.admin.getUserById(id);
    if (!auth.data?.user) {
      sendApiError(res, 404, 'NOT_FOUND', 'Usuário não encontrado.');
      return;
    }

    const { data: prof, error: profErr } = await supabase
      .from('profiles')
      .select('has_paid, complimentary_access_until')
      .eq('id', id)
      .maybeSingle();
    if (profErr) throw new Error(profErr.message);

    const hasPaid = rowHasPaidTrue((prof as { has_paid?: unknown } | null)?.has_paid);
    let newUntil: string | null;

    if (preset === 'none') {
      newUntil = null;
    } else {
      const days = Number(preset);
      const now = Date.now();
      let base = new Date(now);
      const cur = (prof as { complimentary_access_until?: string | null } | null)?.complimentary_access_until;
      if (cur) {
        const t = new Date(String(cur)).getTime();
        if (Number.isFinite(t) && t > now) base = new Date(t);
      }
      newUntil = new Date(base.getTime() + days * 86_400_000).toISOString();
    }

    const isAiEnabled = profileHasWagooAccess({
      has_paid: hasPaid,
      complimentary_access_until: newUntil ?? undefined,
    });

    const { data: updatedRows, error: upErr } = await supabase
      .from('profiles')
      .update({ complimentary_access_until: newUntil, is_ai_enabled: isAiEnabled })
      .eq('id', id)
      .select('id');
    if (upErr) throw new Error(upErr.message);

    if (!updatedRows?.length) {
      const emailNorm = auth.data.user.email ? String(auth.data.user.email).trim().toLowerCase() : null;
      const ins: Record<string, unknown> = {
        id,
        complimentary_access_until: newUntil,
        is_ai_enabled: isAiEnabled,
        has_paid: false,
        is_active: true,
      };
      if (emailNorm) ins.email = emailNorm;
      const { error: insErr } = await supabase.from('profiles').upsert(ins, { onConflict: 'id' });
      if (insErr) throw new Error(insErr.message);
    }

    const actor = getAdminActor(req);
    pushAdminAudit({
      actor,
      action: 'user.complimentary_access.update',
      target: id,
      timestamp: new Date().toISOString(),
      meta: { preset },
    });
    pushAdminEvent('core', `Admin atualizou cortesia de ${id} (${preset})`, 'online');

    const profileMap = await getUserProfileMap([id]);
    const promoUserIds = await getUserIdsWithPromoRedemption([id]);
    const user = buildWagooAdminUserRow(
      auth.data.user as unknown as {
        id: string;
        email?: string;
        created_at?: string;
        last_sign_in_at?: string;
        user_metadata?: Record<string, unknown>;
        app_metadata?: Record<string, unknown>;
        banned_until?: string | null;
      },
      profileMap,
      promoUserIds,
    );
    res.status(200).type(JSON_UTF8).json({ ok: true, data: user });
  } catch (e: unknown) {
    sendApiError(res, 500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
}

router.patch('/users/:id/complimentary-access', handleUserComplimentaryAccess);
router.post('/users/:id/complimentary-access', handleUserComplimentaryAccess);

router.patch('/users/:id/role', async (req: Request, res: Response) => {
  const id = String(req.params.id || '').trim();
  const role = typeof req.body?.role === 'string' ? req.body.role.trim() : '';
  if (!id || !role) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'id e role são obrigatórios.');
    return;
  }
  try {
    const { error } = await supabase.auth.admin.updateUserById(id, { app_metadata: { role } });
    if (error) throw error;
    await supabase.from('profiles').update({ role }).eq('id', id);
    const actor = getAdminActor(req);
    pushAdminAudit({
      actor,
      action: 'user.role.update',
      target: id,
      timestamp: new Date().toISOString(),
      meta: { role },
    });
    pushAdminEvent('core', `Admin atualizou role de ${id}`, 'online');
    res.status(200).type(JSON_UTF8).json({ ok: true, data: { id, role } });
  } catch (e: unknown) {
    sendApiError(res, 500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
});

router.patch('/users/:id/status', async (req: Request, res: Response) => {
  const id = String(req.params.id || '').trim();
  const active = req.body?.active;
  if (!id || typeof active !== 'boolean') {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'id e active(boolean) são obrigatórios.');
    return;
  }
  try {
    const { error } = await supabase.auth.admin.updateUserById(id, {
      user_metadata: { active },
    });
    if (error) throw error;
    /** Desativar só corta acesso (`is_active`); não preenche `deleted_at`. Reativar limpa marcação legada. */
    const profilePatch: Record<string, unknown> = { is_active: active };
    if (active) profilePatch.deleted_at = null;
    await supabase.from('profiles').update(profilePatch).eq('id', id);
    const actor = getAdminActor(req);
    pushAdminAudit({
      actor,
      action: 'user.status.update',
      target: id,
      timestamp: new Date().toISOString(),
      meta: { active },
    });
    pushAdminEvent('core', `Admin atualizou status de ${id}`, active ? 'online' : 'degraded');
    res.status(200).type(JSON_UTF8).json({ ok: true, data: { id, active } });
  } catch (e: unknown) {
    sendApiError(res, 500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
});

router.delete('/users/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id || '').trim();
  if (!id) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'id é obrigatório.');
    return;
  }
  try {
    const nowIso = new Date().toISOString();
    const { error } = await supabase.auth.admin.deleteUser(id);
    if (error) throw error;
    const actor = getAdminActor(req);
    pushAdminAudit({
      actor,
      action: 'user.account.delete',
      target: id,
      timestamp: nowIso,
    });
    pushAdminEvent('core', `Admin removeu conta ${id} (auth + dados em cascata)`, 'degraded');
    res.status(200).type(JSON_UTF8).json({ ok: true, data: { id, deleted: true } });
  } catch (e: unknown) {
    sendApiError(res, 500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
});

router.get('/users/:id/assets', async (req: Request, res: Response) => {
  const id = String(req.params.id || '').trim();
  if (!id) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'id é obrigatório.');
    return;
  }
  try {
    // Tenta fonte dedicada; se não existir tabela, faz fallback para vazio.
    let items: Array<{ id: string; url: string; createdAt: string | null }> = [];
    const { data, error } = await supabase
      .from('user_assets')
      .select('id, url, created_at')
      .eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(200);

    if (!error && data) {
      items = data.map((x: Record<string, unknown>) => ({
        id: String(x.id || ''),
        url: String(x.url || ''),
        createdAt: x.created_at ? String(x.created_at) : null,
      }));
    }

    res.status(200).type(JSON_UTF8).json({ ok: true, data: { items } });
  } catch (e: unknown) {
    sendApiError(res, 500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
});

function generateWagooPromoCode(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buf = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    out += alphabet[buf[i]! % alphabet.length];
  }
  return out.slice(0, 12);
}

function wagooPublicBaseUrl(): string {
  return (process.env.FRONTEND_URL || 'https://wagoobot.com').replace(/\/+$/, '');
}

/** Korven: lista links de cortesia Wagoo (`wagoo_promo_links`). */
router.get('/wagoo/promo-links', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('wagoo_promo_links')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    const base = wagooPublicBaseUrl();
    const items = (data ?? []).map((row: Record<string, unknown>) => {
      const code = String(row.code || '');
      return {
        ...row,
        signup_url: `${base}/login?wagoo_promo=${encodeURIComponent(code)}`,
      };
    });
    res.status(200).type(JSON_UTF8).json({ ok: true, data: { items } });
  } catch (e: unknown) {
    sendApiError(res, 500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
});

/** Korven: cria link de cortesia (padrão 60 dias ≈ 2 meses). */
router.post('/wagoo/promo-links', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 200) : null;
    let days = 60;
    if (typeof body.complimentary_days === 'number' && Number.isFinite(body.complimentary_days)) {
      days = Math.min(730, Math.max(1, Math.round(body.complimentary_days)));
    }
    let maxRedemptions: number | null = null;
    if (body.max_redemptions === null) maxRedemptions = null;
    else if (typeof body.max_redemptions === 'number' && Number.isFinite(body.max_redemptions)) {
      maxRedemptions = Math.max(1, Math.round(body.max_redemptions));
    }
    let expiresAt: string | null = null;
    if (typeof body.expires_at === 'string' && body.expires_at.trim()) {
      const d = new Date(body.expires_at);
      if (!Number.isNaN(d.getTime())) expiresAt = d.toISOString();
    }

    let code = generateWagooPromoCode();
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data, error } = await supabase
        .from('wagoo_promo_links')
        .insert({
          code,
          label: label || null,
          complimentary_days: days,
          max_redemptions: maxRedemptions,
          expires_at: expiresAt,
        })
        .select('*')
        .single();
      if (!error && data) {
        const base = wagooPublicBaseUrl();
        const actor = getAdminActor(req);
        pushAdminAudit({
          actor,
          action: 'wagoo.promo_link.create',
          target: String(data.id),
          timestamp: new Date().toISOString(),
          meta: { code: data.code },
        });
        return res.status(200).type(JSON_UTF8).json({
          ok: true,
          data: {
            ...data,
            signup_url: `${base}/login?wagoo_promo=${encodeURIComponent(String(data.code))}`,
          },
        });
      }
      if (error?.code !== '23505') {
        throw new Error(error?.message || 'insert failed');
      }
      code = generateWagooPromoCode();
    }
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Não foi possível gerar código único.');
  } catch (e: unknown) {
    sendApiError(res, 500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
});

/** Korven: ativa/desativa link de cortesia. */
router.patch('/wagoo/promo-links/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id || '').trim();
  if (!id) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'id é obrigatório.');
    return;
  }
  const active = req.body?.is_active;
  if (typeof active !== 'boolean') {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'is_active (boolean) é obrigatório.');
    return;
  }
  try {
    const { data, error } = await supabase
      .from('wagoo_promo_links')
      .update({ is_active: active })
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      sendApiError(res, 404, 'NOT_FOUND', 'Link não encontrado.');
      return;
    }
    const actor = getAdminActor(req);
    pushAdminAudit({
      actor,
      action: 'wagoo.promo_link.patch',
      target: id,
      timestamp: new Date().toISOString(),
      meta: { is_active: active },
    });
    res.status(200).type(JSON_UTF8).json({ ok: true, data });
  } catch (e: unknown) {
    sendApiError(res, 500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
});

/** Korven: remove link de cortesia (`wagoo_promo_redemptions` em CASCADE). */
router.delete('/wagoo/promo-links/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id || '').trim();
  if (!id) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'id é obrigatório.');
    return;
  }
  try {
    const { data, error } = await supabase.from('wagoo_promo_links').delete().eq('id', id).select('id').maybeSingle();
    if (error) throw error;
    if (!data) {
      sendApiError(res, 404, 'NOT_FOUND', 'Link não encontrado.');
      return;
    }
    const actor = getAdminActor(req);
    pushAdminAudit({
      actor,
      action: 'wagoo.promo_link.delete',
      target: id,
      timestamp: new Date().toISOString(),
    });
    res.status(200).type(JSON_UTF8).json({ ok: true, data: { id, deleted: true } });
  } catch (e: unknown) {
    sendApiError(res, 500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
});

router.get('/audit', (_req: Request, res: Response) => {
  res.status(200).type(JSON_UTF8).json({ ok: true, data: { items: adminAudit } });
});

router.post('/events/test', (req: Request, res: Response) => {
  const { app, message, status } = req.body as {
    app?: AdminApp;
    message?: string;
    status?: AdminEventStatus;
  };
  if (!message || typeof message !== 'string') {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'message é obrigatório.');
    return;
  }
  const ap = app === 'wagoo' || app === '2avendas' || app === 'core' ? app : 'core';
  const st =
    status === 'online' || status === 'degraded' || status === 'offline' ? status : 'online';
  pushAdminEvent(ap, message, st);
  res.status(200).type(JSON_UTF8).json({ ok: true });
});

router.use((req: Request, res: Response) => {
  sendApiError(res, 404, 'NOT_FOUND', 'Endpoint admin não encontrado.');
});

router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : 'Erro interno';
  sendApiError(res, 500, 'INTERNAL_ERROR', message);
});

export default router;
