import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { subDays, startOfDay, formatISO } from 'date-fns';
import { sessions } from '../services/whatsapp';
import { getAdminEvents, pushAdminEvent, AdminApp, AdminEventStatus } from '../services/adminEvents';

dotenv.config();

const router = express.Router();

const stripeKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeKey ? new Stripe(stripeKey, { apiVersion: '2023-10-16' }) : null;

const supabase: SupabaseClient = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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

function getUpstreamSecret(): string {
  return (process.env.ADMIN_API_SECRET || process.env.API_SECRET || '').trim();
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
      'Segredo API não configurado (ADMIN_API_SECRET ou API_SECRET).'
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
  createdAt: string;
  lastSignInAt: string | null;
};

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
  }
): AdminUserRow {
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

  return {
    id: authUser.id,
    email: authUser.email ?? profile?.email ?? null,
    name:
      (authUser.user_metadata?.name as string | undefined) ||
      (profile?.store_name as string | undefined) ||
      null,
    role,
    active,
    createdAt: authUser.created_at || new Date(0).toISOString(),
    lastSignInAt: authUser.last_sign_in_at || null,
  };
}

async function getUserProfileMap(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) return map;
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, store_name, role, is_active, deleted_at')
    .in('id', ids);
  if (error || !data) return map;
  for (const row of data as unknown as Record<string, unknown>[]) {
    const id = row.id;
    if (typeof id === 'string') map.set(id, row);
  }
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

    const items = pageUsers.map((u) =>
      normalizeAdminUser(
        u as unknown as {
          id: string;
          email?: string;
          created_at?: string;
          last_sign_in_at?: string;
          user_metadata?: Record<string, unknown>;
          app_metadata?: Record<string, unknown>;
          banned_until?: string | null;
        },
        profileMap.get(u.id) as unknown as {
          email?: string | null;
          store_name?: string | null;
          role?: string | null;
          is_active?: boolean | null;
          deleted_at?: string | null;
        }
      )
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
    const user = normalizeAdminUser(
      data.user as unknown as {
        id: string;
        email?: string;
        created_at?: string;
        last_sign_in_at?: string;
        user_metadata?: Record<string, unknown>;
        app_metadata?: Record<string, unknown>;
        banned_until?: string | null;
      },
      profileMap.get(id) as unknown as {
        email?: string | null;
        store_name?: string | null;
        role?: string | null;
        is_active?: boolean | null;
        deleted_at?: string | null;
      }
    );
    res.status(200).type(JSON_UTF8).json({ ok: true, data: user });
  } catch (e: unknown) {
    sendApiError(res, 500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
});

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
    await supabase.from('profiles').update({ is_active: active, deleted_at: active ? null : new Date().toISOString() }).eq('id', id);
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
    const { error } = await supabase.auth.admin.updateUserById(id, {
      user_metadata: { active: false, deleted: true, deleted_at: nowIso },
    });
    if (error) throw error;
    await supabase
      .from('profiles')
      .update({ is_active: false, deleted_at: nowIso })
      .eq('id', id);
    const actor = getAdminActor(req);
    pushAdminAudit({
      actor,
      action: 'user.soft_delete',
      target: id,
      timestamp: nowIso,
    });
    pushAdminEvent('core', `Admin aplicou soft delete em ${id}`, 'degraded');
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
