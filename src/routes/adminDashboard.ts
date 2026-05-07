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

type ApiErrorCode = 'UNAUTHORIZED' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR';

function sendApiError(
  res: Response,
  status: number,
  code: ApiErrorCode,
  error: string
): void {
  res.status(status).type('application/json').json({ ok: false, error, code });
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.ADMIN_API_SECRET?.trim();
  if (!configured) {
    sendApiError(
      res,
      500,
      'INTERNAL_ERROR',
      'ADMIN_API_SECRET não configurado no servidor.'
    );
    return;
  }
  const headerSecret =
    (req.headers['x-admin-secret'] as string | undefined)?.trim() ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7).trim()
      : undefined);
  if (!headerSecret || headerSecret !== configured) {
    sendApiError(res, 401, 'UNAUTHORIZED', 'Não autorizado.');
    return;
  }
  next();
}

router.use(requireAdmin);

function parsePeriodDays(raw: unknown): { ok: true; value: number } | { ok: false } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: 14 };
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
  { id: string; email?: string; last_sign_in_at?: string | null }[]
> {
  const users: { id: string; email?: string; last_sign_in_at?: string | null }[] = [];
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const pageUsers = data?.users ?? [];
    const batch = pageUsers.map((u) => ({
      id: u.id,
      email: u.email ?? undefined,
      last_sign_in_at: u.last_sign_in_at ?? null,
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

router.get('/dashboard', async (req: Request, res: Response) => {
  const parsedPeriod = parsePeriodDays(req.query.periodDays);
  if (!parsedPeriod.ok) {
    sendApiError(
      res,
      400,
      'VALIDATION_ERROR',
      'periodDays deve ser um inteiro entre 1 e 90.'
    );
    return;
  }
  const periodDays = parsedPeriod.value;
  const organization =
    typeof req.query.organization === 'string' ? req.query.organization : undefined;

  const now = new Date();
  const nowUnix = Math.floor(now.getTime() / 1000);
  const periodStart = Math.floor(subDays(now, periodDays).getTime() / 1000);
  const prevStart = Math.floor(subDays(now, periodDays * 2).getTime() / 1000);
  const prevEnd = periodStart - 1;

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
      const invWindow = await listPaidInvoicesByPaidAtRange(
        stripe,
        prevStart,
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
      revenueCurrentPeriod = sumInvoiceAmountBrl(invCurrent);
      revenuePrevPeriod = sumInvoiceAmountBrl(invPrev);
      revenuePerDay = bucketByDayBrl(invCurrent, periodDays);
      activeSubscriptions = await countActiveSubscriptions(stripe);
      newSubsCurrent = await countSubscriptionsCreatedInRange(stripe, periodStart, nowUnix);
      newSubsPrev = await countSubscriptionsCreatedInRange(stripe, prevStart, prevEnd);
    } catch (e: unknown) {
      warnings.push(`Stripe: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const avendas = parseAvendasMetrics();

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
    app: e.app === '2avendas' ? 'core' : e.app,
    status: e.status,
    message: e.message,
    timestamp: e.timestamp,
  }));

  res
    .status(200)
    .type('application/json')
    .json({
      ok: true,
      gerado_em: nowIso,
      filtros: {
        periodDays,
        ...(organization ? { organization } : {}),
      },
      kpis: {
        receita_total: {
          valor: revenueCurrentPeriod,
          delta_pct: pctChange(revenueCurrentPeriod, revenuePrevPeriod) ?? 0,
        },
        assinaturas_ativas_wagoo: {
          valor: activeSubscriptions,
          delta_pct: pctChange(newSubsCurrent, newSubsPrev) ?? 0,
        },
        uptime_medio: {
          valor: Math.round(averageUptimePct * 100) / 100,
          delta_pct: 0,
        },
      },
      wagoo: {
        receita_por_dia: revenuePerDay.map((d) => ({
          data: d.date,
          receita: d.amountBrl,
        })),
      },
      eventos_recentes: eventos,
      // bloco legado para compatibilidade do painel atual
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
});

router.get('/users', async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);

  let profiles: {
    id: string;
    email: string | null;
    has_paid: boolean | null;
    whatsapp_session: unknown;
    is_ai_enabled: boolean | null;
  }[] = [];

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, has_paid, whatsapp_session, is_ai_enabled')
      .order('email', { ascending: true })
      .limit(limit);
    if (error) throw error;
    profiles = data ?? [];
  } catch (e: unknown) {
    sendApiError(res, 500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
    return;
  }

  const rows = profiles.map((p) => ({
    email: p.email,
    userId: p.id,
    paying: !!p.has_paid,
    aiEnabled: !!p.is_ai_enabled,
    whatsappConfigured: p.whatsapp_session != null,
    botOnlineNow: !!(p.email && sessions[p.email]),
  }));

  res.status(200).type('application/json').json({
    count: rows.length,
    users: rows,
  });
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
  res.status(200).type('application/json').json({ ok: true });
});

router.use((req: Request, res: Response) => {
  sendApiError(res, 404, 'VALIDATION_ERROR', 'Endpoint admin não encontrado.');
});

router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : 'Erro interno';
  sendApiError(res, 500, 'INTERNAL_ERROR', message);
});

export default router;
