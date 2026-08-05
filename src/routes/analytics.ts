import express, { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { profileHasWagooAccess } from '../lib/profileAccess';
import { profileSubscriptionTier } from '../lib/profileMultiBarber';
import { listAllBarbeirosForUser } from '../lib/barbeiros';
import { tierSupportsCsvExport } from '../lib/wagooSubscription';
import { listCalendarEvents } from '../services/calendar';
import {
  ANALYTICS_EXPORT_COLUMNS,
  DEFAULT_ANALYTICS_EXPORT_COLUMNS,
  buildBarberPeriodTotals,
  buildStoreInvoicingSummary,
  earningsTemplateCsv,
  eventsToCsvWithCommission,
  foldName,
  isStoreSpreadsheetRow,
  normalizeExportColumns,
  parseEarningsUploadCsv,
  type ManualEarningsEntry,
  type PaidAppointmentForExport,
} from '../lib/csvCommissionExport';

const router = Router();

type AuthOk = { ok: true; userId: string };
type AuthFail = { ok: false; status: number; error: string };

async function requireAnalyticsAccess(req: Request): Promise<AuthOk | AuthFail> {
  const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
  if (!auth.ok) {
    return {
      ok: false,
      status: 401,
      error:
        auth.reason === 'missing_token'
          ? 'Envie Authorization: Bearer com o access_token da sessão.'
          : 'Sessão inválida ou expirada.',
    };
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select(
      'id, email, has_paid, complimentary_access_until, subscription_tier, multi_barber_plan, googleAuth, analytics_export_columns',
    )
    .eq('id', auth.user.id)
    .maybeSingle();

  if (error || !profile) {
    return { ok: false, status: 404, error: 'Perfil não encontrado.' };
  }

  const row = profile as Record<string, unknown>;
  if (
    !profileHasWagooAccess({
      has_paid: row.has_paid,
      complimentary_access_until: row.complimentary_access_until,
    })
  ) {
    return { ok: false, status: 403, error: 'Assinatura activa necessária.' };
  }

  const tier = profileSubscriptionTier({
    subscription_tier: row.subscription_tier,
    has_paid: row.has_paid,
    multi_barber_plan: row.multi_barber_plan as boolean | null | undefined,
  });
  if (!tierSupportsCsvExport(tier)) {
    return {
      ok: false,
      status: 403,
      error: 'Analytics avançado está disponível nos planos Pro e Pro+.',
    };
  }

  return { ok: true, userId: auth.user.id };
}

async function loadProfileRow(userId: string) {
  const { data } = await supabase
    .from('profiles')
    .select(
      'id, email, googleAuth, analytics_export_columns, has_paid, complimentary_access_until, subscription_tier, multi_barber_plan',
    )
    .eq('id', userId)
    .maybeSingle();
  return data as Record<string, unknown> | null;
}

export async function loadPaidAppointmentsForExport(
  profileId: string,
  from: string,
  to: string,
): Promise<PaidAppointmentForExport[]> {
  const { data, error } = await supabase
    .from('booking_appointments')
    .select(
      'id, google_event_id, client_name, client_phone, starts_at, ends_at, price_brl, deposit_amount_brl, application_fee_brl, payment_status, notes, booking_providers(name)',
    )
    .eq('profile_id', profileId)
    .eq('payment_status', 'paid')
    .gte('starts_at', from)
    .lte('starts_at', to)
    .order('starts_at', { ascending: true });

  if (error) {
    console.error('[analytics] paid appointments:', error.message);
    return [];
  }

  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const provider = r.booking_providers as { name?: string } | null | undefined;
    return {
      id: String(r.id),
      google_event_id: r.google_event_id ? String(r.google_event_id) : null,
      client_name: String(r.client_name ?? ''),
      client_phone: String(r.client_phone ?? ''),
      starts_at: String(r.starts_at),
      ends_at: String(r.ends_at),
      price_brl: Number(r.price_brl) || 0,
      deposit_amount_brl:
        r.deposit_amount_brl != null ? Number(r.deposit_amount_brl) : null,
      application_fee_brl:
        r.application_fee_brl != null ? Number(r.application_fee_brl) : null,
      payment_status: String(r.payment_status ?? 'paid'),
      notes: r.notes != null ? String(r.notes) : null,
      provider_name: provider?.name ? String(provider.name) : null,
    };
  });
}

function monthsCovered(fromIso: string, toIso: string): { year: number; month: number }[] {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return [];
  const out: { year: number; month: number }[] = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (cur <= end) {
    out.push({ year: cur.getUTCFullYear(), month: cur.getUTCMonth() + 1 });
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

async function loadManualEntriesForRange(
  profileId: string,
  from: string,
  to: string,
): Promise<ManualEarningsEntry[]> {
  const months = monthsCovered(from, to);
  if (!months.length) return [];

  const years = [...new Set(months.map((m) => m.year))];
  const { data, error } = await supabase
    .from('barber_earnings_entries')
    .select('barber_name, amount_brl, period_year, period_month')
    .eq('profile_id', profileId)
    .in('period_year', years);

  if (error) {
    console.error('[analytics] earnings entries:', error.message);
    return [];
  }

  const monthSet = new Set(months.map((m) => `${m.year}-${m.month}`));
  return (data ?? [])
    .filter((r) => monthSet.has(`${r.period_year}-${r.period_month}`))
    .map((r) => ({
      barber_name: String(r.barber_name),
      amount_brl: Number(r.amount_brl) || 0,
      period_year: Number(r.period_year),
      period_month: Number(r.period_month),
    }));
}

/** Preferências + colunas disponíveis. */
router.get('/export-preferences', async (req: Request, res: Response) => {
  const gate = await requireAnalyticsAccess(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const profile = await loadProfileRow(gate.userId);
  const columns = normalizeExportColumns(profile?.analytics_export_columns);

  res.json({
    columns,
    available_columns: [...ANALYTICS_EXPORT_COLUMNS],
    default_columns: [...DEFAULT_ANALYTICS_EXPORT_COLUMNS],
  });
});

router.put('/export-preferences', express.json(), async (req: Request, res: Response) => {
  const gate = await requireAnalyticsAccess(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const columns = normalizeExportColumns(req.body?.columns);
  const { error } = await supabase
    .from('profiles')
    .update({ analytics_export_columns: columns })
    .eq('id', gate.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ columns });
});

async function loadClubRevenueForRange(
  profileId: string,
  from: string,
  to: string,
): Promise<{ revenueBrl: number; count: number }> {
  const { data: plan } = await supabase
    .from('club_plans')
    .select('id, price_brl')
    .eq('profile_id', profileId)
    .maybeSingle();

  if (!plan) return { revenueBrl: 0, count: 0 };

  const price = Number(plan.price_brl) || 0;
  const { data: members } = await supabase
    .from('club_members')
    .select('id, status, current_period_start, current_period_end')
    .eq('profile_id', profileId)
    .in('status', ['active', 'past_due']);

  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  let count = 0;
  for (const m of members ?? []) {
    const start = m.current_period_start
      ? new Date(m.current_period_start).getTime()
      : null;
    const end = m.current_period_end ? new Date(m.current_period_end).getTime() : null;
    // Conta mensalidade cujo período cruza o intervalo (renovação no range)
    const overlaps =
      (start != null && start >= fromMs && start <= toMs) ||
      (end != null && end >= fromMs && end <= toMs) ||
      (start != null &&
        end != null &&
        start <= fromMs &&
        end >= toMs);
    if (overlaps) count += 1;
  }

  return {
    revenueBrl: Math.round(count * price * 100) / 100,
    count,
  };
}

function applyUploadToBarbers(
  barbers: ReturnType<typeof buildBarberPeriodTotals>,
  uploadedRows: { profissional: string; valor: number }[],
): ReturnType<typeof buildBarberPeriodTotals> {
  if (!uploadedRows.length) return barbers;
  const map = new Map(barbers.map((b) => [foldName(b.profissional), { ...b }]));
  for (const u of uploadedRows) {
    if (isStoreSpreadsheetRow(u.profissional)) continue;
    const name = u.profissional.trim();
    if (!name) continue;
    const key = foldName(name);
    const amount = Math.round((Number(u.valor) || 0) * 100) / 100;
    const prev = map.get(key);
    map.set(key, {
      profissional: name,
      paid_appointments_count: prev?.paid_appointments_count ?? 0,
      faturamento_brl: prev?.faturamento_brl ?? 0,
      auto_commission_brl: prev?.auto_commission_brl ?? 0,
      manual_amount_brl: amount,
      final_amount_brl: amount,
      source: 'manual',
    });
  }
  return [...map.values()].sort((a, b) =>
    a.profissional.localeCompare(b.profissional, 'pt'),
  );
}

async function buildAnalyticsSummaryPayload(
  userId: string,
  from: string,
  to: string,
  uploadedRows?: { profissional: string; valor: number }[],
) {
  const [barbeiros, paidAppointments, manualEntries, club] = await Promise.all([
    listAllBarbeirosForUser(userId),
    loadPaidAppointmentsForExport(userId, from, to),
    loadManualEntriesForRange(userId, from, to),
    loadClubRevenueForRange(userId, from, to),
  ]);

  let barbers = buildBarberPeriodTotals({
    paidAppointments,
    barbeiros,
    manualEntries,
  });
  if (uploadedRows?.length) {
    barbers = applyUploadToBarbers(barbers, uploadedRows);
  }

  const store = buildStoreInvoicingSummary({
    barbeirosCount: barbeiros.length,
    paidAppointments,
    barbers,
    clubRevenueBrl: club.revenueBrl,
    clubPaymentsCount: club.count,
    uploadedRows,
  });

  return {
    from,
    to,
    barbers,
    store,
    totals: {
      paid_appointments: store.paid_appointments,
      final_amount_brl: store.ganhos_barbeiros_brl,
      auto_commission_brl: barbers.reduce((s, b) => s + b.auto_commission_brl, 0),
      caixa_loja_brl: store.caixa_loja_brl,
      caixa_stripe_brl: store.caixa_stripe_brl,
      faturamento_servicos_brl: store.faturamento_servicos_brl,
      barbeiros_equipe: store.barbeiros_equipe,
    },
  };
}

/** Totais por barbeiro + faturamento da loja no período. */
router.get('/summary', async (req: Request, res: Response) => {
  const gate = await requireAnalyticsAccess(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const from = String(req.query.from ?? '').trim();
  const to = String(req.query.to ?? '').trim();
  if (!from || !to) {
    return res.status(400).json({ error: 'Parâmetros from e to (ISO) são obrigatórios.' });
  }

  const payload = await buildAnalyticsSummaryPayload(gate.userId, from, to);
  res.json(payload);
});

/** Recalcula o dashboard após merge de planilha (sem baixar CSV). */
router.post('/summary/preview', express.json({ limit: '2mb' }), async (req: Request, res: Response) => {
  const gate = await requireAnalyticsAccess(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const from = String(req.body?.from ?? '').trim();
  const to = String(req.body?.to ?? '').trim();
  if (!from || !to) {
    return res.status(400).json({ error: 'Parâmetros from e to são obrigatórios.' });
  }

  let uploadedRows: { profissional: string; valor: number }[] | undefined;
  const csvText = req.body?.csv != null ? String(req.body.csv) : '';
  if (csvText.trim()) {
    const parsed = parseEarningsUploadCsv(csvText);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    uploadedRows = parsed.rows;
  }

  const payload = await buildAnalyticsSummaryPayload(
    gate.userId,
    from,
    to,
    uploadedRows,
  );
  res.json(payload);
});

router.get('/earnings-entries', async (req: Request, res: Response) => {
  const gate = await requireAnalyticsAccess(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: 'Informe year e month válidos.' });
  }

  const { data, error } = await supabase
    .from('barber_earnings_entries')
    .select(
      'id, barbeiro_id, barber_name, period_year, period_month, amount_brl, note, created_at, updated_at',
    )
    .eq('profile_id', gate.userId)
    .eq('period_year', year)
    .eq('period_month', month)
    .order('barber_name', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ entries: data ?? [] });
});

router.post('/earnings-entries', express.json(), async (req: Request, res: Response) => {
  const gate = await requireAnalyticsAccess(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const year = Number(req.body?.period_year ?? req.body?.year);
  const month = Number(req.body?.period_month ?? req.body?.month);
  const amount = Number(req.body?.amount_brl ?? req.body?.amount);
  let barberName = String(req.body?.barber_name ?? req.body?.nome ?? '').trim();
  const barbeiroId = req.body?.barbeiro_id ? String(req.body.barbeiro_id) : null;
  const note = String(req.body?.note ?? '').trim();

  if (!Number.isFinite(year) || year < 2020 || year > 2100) {
    return res.status(400).json({ error: 'Ano inválido.' });
  }
  if (!Number.isFinite(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: 'Mês inválido.' });
  }
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ error: 'Valor inválido.' });
  }

  if (barbeiroId) {
    const barbeiros = await listAllBarbeirosForUser(gate.userId);
    const match = barbeiros.find((b) => b.id === barbeiroId);
    if (!match) return res.status(404).json({ error: 'Profissional não encontrado.' });
    barberName = match.nome;
  }

  if (!barberName) {
    return res.status(400).json({ error: 'Informe o nome do profissional.' });
  }

  const amountRounded = Math.round(amount * 100) / 100;

  const { data: periodRows } = await supabase
    .from('barber_earnings_entries')
    .select('id, barber_name')
    .eq('profile_id', gate.userId)
    .eq('period_year', year)
    .eq('period_month', month);

  const existing = (periodRows ?? []).find(
    (r) => foldName(String(r.barber_name)) === foldName(barberName),
  );

  if (existing?.id) {
    const { data, error } = await supabase
      .from('barber_earnings_entries')
      .update({
        amount_brl: amountRounded,
        note,
        barbeiro_id: barbeiroId,
        barber_name: barberName,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .eq('profile_id', gate.userId)
      .select(
        'id, barbeiro_id, barber_name, period_year, period_month, amount_brl, note, created_at, updated_at',
      )
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  }

  const { data, error } = await supabase
    .from('barber_earnings_entries')
    .insert({
      profile_id: gate.userId,
      barbeiro_id: barbeiroId,
      barber_name: barberName,
      period_year: year,
      period_month: month,
      amount_brl: amountRounded,
      note,
    })
    .select(
      'id, barbeiro_id, barber_name, period_year, period_month, amount_brl, note, created_at, updated_at',
    )
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/earnings-entries/:id', express.json(), async (req: Request, res: Response) => {
  const gate = await requireAnalyticsAccess(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const id = String(req.params.id);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (req.body?.amount_brl != null || req.body?.amount != null) {
    const amount = Number(req.body?.amount_brl ?? req.body?.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: 'Valor inválido.' });
    }
    patch.amount_brl = Math.round(amount * 100) / 100;
  }
  if (req.body?.note != null) patch.note = String(req.body.note).trim();
  if (req.body?.barber_name != null || req.body?.nome != null) {
    const name = String(req.body?.barber_name ?? req.body?.nome).trim();
    if (!name) return res.status(400).json({ error: 'Nome inválido.' });
    patch.barber_name = name;
  }

  const { data, error } = await supabase
    .from('barber_earnings_entries')
    .update(patch)
    .eq('id', id)
    .eq('profile_id', gate.userId)
    .select(
      'id, barbeiro_id, barber_name, period_year, period_month, amount_brl, note, created_at, updated_at',
    )
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Lançamento não encontrado.' });
  res.json(data);
});

router.delete('/earnings-entries/:id', async (req: Request, res: Response) => {
  const gate = await requireAnalyticsAccess(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const id = String(req.params.id);
  const { error } = await supabase
    .from('barber_earnings_entries')
    .delete()
    .eq('id', id)
    .eq('profile_id', gate.userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.get('/export/template', async (req: Request, res: Response) => {
  const gate = await requireAnalyticsAccess(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="wagoo-ganhos-template.csv"',
  );
  res.send(`\uFEFF${earningsTemplateCsv()}`);
});

async function buildExportCsv(opts: {
  userId: string;
  from: string;
  to: string;
  columns?: unknown;
  uploadedRows?: { profissional: string; valor: number }[];
  requireGoogle?: boolean;
}): Promise<{ ok: true; csv: string } | { ok: false; status: number; error: string }> {
  const profile = await loadProfileRow(opts.userId);
  if (!profile) return { ok: false, status: 404, error: 'Perfil não encontrado.' };

  const googleAuth = profile.googleAuth as Record<string, unknown> | null | undefined;
  const googleConnected = Boolean(googleAuth?.refreshToken);
  if (opts.requireGoogle !== false && !googleConnected) {
    return {
      ok: false,
      status: 400,
      error: 'Conecte o Google Agenda para exportar agendamentos.',
    };
  }

  const columns = normalizeExportColumns(
    opts.columns ?? profile.analytics_export_columns,
  );
  const email = String(profile.email || '')
    .toLowerCase()
    .trim();

  const [events, barbeiros, paidAppointments, manualEntries] = await Promise.all([
    googleConnected && email
      ? listCalendarEvents(email, opts.from, opts.to)
      : Promise.resolve([]),
    listAllBarbeirosForUser(opts.userId),
    loadPaidAppointmentsForExport(opts.userId, opts.from, opts.to),
    loadManualEntriesForRange(opts.userId, opts.from, opts.to),
  ]);

  const csv = eventsToCsvWithCommission({
    events,
    paidAppointments,
    barbeiros,
    manualEntries,
    columns,
    uploadedRows: opts.uploadedRows,
  });

  return { ok: true, csv };
}

router.get('/export', async (req: Request, res: Response) => {
  const gate = await requireAnalyticsAccess(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const from = String(req.query.from ?? '').trim();
  const to = String(req.query.to ?? '').trim();
  if (!from || !to) {
    return res.status(400).json({ error: 'Parâmetros from e to (ISO) são obrigatórios.' });
  }

  let columns: unknown;
  if (req.query.columns) {
    columns = String(req.query.columns)
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
  }

  const built = await buildExportCsv({
    userId: gate.userId,
    from,
    to,
    columns,
    requireGoogle: false,
  });
  if (!built.ok) return res.status(built.status).json({ error: built.error });

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="wagoo-analytics-${stamp}.csv"`,
  );
  res.send(`\uFEFF${built.csv}`);
});

/** Merge: body JSON `{ from, to, csv, columns? }` — evita dependência multer. */
router.post('/export/merge', express.json({ limit: '2mb' }), async (req: Request, res: Response) => {
  const gate = await requireAnalyticsAccess(req);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const from = String(req.body?.from ?? '').trim();
  const to = String(req.body?.to ?? '').trim();
  const csvText = String(req.body?.csv ?? '');
  if (!from || !to) {
    return res.status(400).json({ error: 'Parâmetros from e to são obrigatórios.' });
  }

  const parsed = parseEarningsUploadCsv(csvText);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const built = await buildExportCsv({
    userId: gate.userId,
    from,
    to,
    columns: req.body?.columns,
    uploadedRows: parsed.rows,
    requireGoogle: false,
  });
  if (!built.ok) return res.status(built.status).json({ error: built.error });

  const barbeiros = await listAllBarbeirosForUser(gate.userId);
  const teamKeys = new Set(barbeiros.map((b) => b.nome.trim().toLowerCase()));
  const matches = parsed.rows.filter((r) =>
    teamKeys.has(r.profissional.trim().toLowerCase()),
  ).length;

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="wagoo-analytics-merge-${stamp}.csv"`,
  );
  res.setHeader('X-Wagoo-Merge-Rows', String(parsed.rows.length));
  res.setHeader('X-Wagoo-Merge-Matches', String(matches));
  res.setHeader(
    'Access-Control-Expose-Headers',
    'X-Wagoo-Merge-Rows, X-Wagoo-Merge-Matches, Content-Disposition',
  );
  res.send(`\uFEFF${built.csv}`);
});

export default router;
