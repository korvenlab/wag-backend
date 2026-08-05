import { parseAiBookingNotes } from './bookingCatalog';
import type { BarbeiroRow } from './barbeiros';
import type { CalendarEventDto } from '../services/calendar';
import {
  brlToCents,
  centsToBrl,
  computeApplicationFeeCents,
  estimateShopNetCents,
  type StripePaymentMethodFee,
} from './connectFees';

export type PaidAppointmentForExport = {
  id: string;
  google_event_id: string | null;
  client_name: string;
  client_phone: string;
  starts_at: string;
  ends_at: string;
  price_brl: number;
  /** Valor cobrado via Stripe (sinal); se null, não conta no caixa Stripe. */
  deposit_amount_brl: number | null;
  application_fee_brl: number | null;
  payment_status: string;
  notes: string | null;
  provider_name: string | null;
};

export type ManualEarningsEntry = {
  barber_name: string;
  amount_brl: number;
  period_year: number;
  period_month: number;
};

export type BarberPeriodTotal = {
  profissional: string;
  paid_appointments_count: number;
  faturamento_brl: number;
  auto_commission_brl: number;
  manual_amount_brl: number | null;
  final_amount_brl: number;
  source: 'manual' | 'automatic' | 'none';
};

export const ANALYTICS_EXPORT_COLUMNS = [
  'data_inicio',
  'data_fim',
  'cliente',
  'telefone',
  'profissional',
  'titulo',
  'origem',
  'valor_servico',
  'status_pagamento',
  'comissao_percent',
  'comissao_brl',
  'ganho_manual_brl',
  'ganho_final_brl',
] as const;

export type AnalyticsExportColumn = (typeof ANALYTICS_EXPORT_COLUMNS)[number];

export const DEFAULT_ANALYTICS_EXPORT_COLUMNS: AnalyticsExportColumn[] = [
  'data_inicio',
  'data_fim',
  'cliente',
  'telefone',
  'profissional',
  'titulo',
  'origem',
  'valor_servico',
  'status_pagamento',
  'comissao_percent',
  'comissao_brl',
  'ganho_manual_brl',
  'ganho_final_brl',
];

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function moneyBr(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export function foldName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export function resolveBarberCommissionPercent(
  barbeiros: Pick<BarbeiroRow, 'nome' | 'commission_percent'>[],
  professionalName: string | null | undefined,
): number {
  if (!professionalName?.trim()) return 0;
  const key = foldName(professionalName);
  if (!key || key.includes('sem prefer')) return 0;
  const match = barbeiros.find((b) => foldName(b.nome) === key);
  if (!match) return 0;
  const pct = Number(match.commission_percent) || 0;
  return Math.min(100, Math.max(0, pct));
}

export function professionalNameFromPaidAppt(appt: PaidAppointmentForExport): string {
  if (appt.provider_name?.trim()) return appt.provider_name.trim();
  const ai = parseAiBookingNotes(appt.notes);
  if (ai.barberName?.trim()) return ai.barberName.trim();
  return '';
}

export function normalizeExportColumns(raw: unknown): AnalyticsExportColumn[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [...DEFAULT_ANALYTICS_EXPORT_COLUMNS];
  }
  const allowed = new Set<string>(ANALYTICS_EXPORT_COLUMNS);
  const out: AnalyticsExportColumn[] = [];
  for (const item of raw) {
    const key = String(item);
    if (allowed.has(key) && !out.includes(key as AnalyticsExportColumn)) {
      out.push(key as AnalyticsExportColumn);
    }
  }
  return out.length ? out : [...DEFAULT_ANALYTICS_EXPORT_COLUMNS];
}

/** Mapa nome normalizado → valor manual (soma se houver vários meses no período). */
export function manualEarningsByName(
  entries: ManualEarningsEntry[],
): Map<string, { name: string; amount: number }> {
  const map = new Map<string, { name: string; amount: number }>();
  for (const e of entries) {
    const name = String(e.barber_name || '').trim();
    if (!name) continue;
    const key = foldName(name);
    const amount = Math.round((Number(e.amount_brl) || 0) * 100) / 100;
    const prev = map.get(key);
    map.set(key, {
      name: prev?.name || name,
      amount: Math.round(((prev?.amount ?? 0) + amount) * 100) / 100,
    });
  }
  return map;
}

export function buildBarberPeriodTotals(opts: {
  paidAppointments: PaidAppointmentForExport[];
  barbeiros: Pick<BarbeiroRow, 'nome' | 'commission_percent'>[];
  manualEntries: ManualEarningsEntry[];
}): BarberPeriodTotal[] {
  const { paidAppointments, barbeiros, manualEntries } = opts;
  type Acc = {
    displayName: string;
    count: number;
    faturamento: number;
    auto: number;
  };
  const autoMap = new Map<string, Acc>();

  for (const appt of paidAppointments) {
    const professional = professionalNameFromPaidAppt(appt) || '(sem profissional)';
    const key = foldName(professional);
    const price = Number(appt.price_brl) || 0;
    const pct = resolveBarberCommissionPercent(barbeiros, professional);
    const commission = (price * pct) / 100;
    const prev = autoMap.get(key) ?? {
      displayName: professional,
      count: 0,
      faturamento: 0,
      auto: 0,
    };
    autoMap.set(key, {
      displayName: prev.displayName,
      count: prev.count + 1,
      faturamento: prev.faturamento + price,
      auto: prev.auto + commission,
    });
  }

  const manualMap = manualEarningsByName(manualEntries);
  const keys = new Set([...autoMap.keys(), ...manualMap.keys()]);

  // Inclui barbeiros da equipe mesmo sem movimento
  for (const b of barbeiros) {
    const key = foldName(b.nome);
    if (key) keys.add(key);
    if (!autoMap.has(key) && !manualMap.has(key)) {
      // will appear with zeros via keys
    }
  }

  const rows: BarberPeriodTotal[] = [];
  for (const key of keys) {
    const auto = autoMap.get(key);
    const manual = manualMap.get(key);
    const displayName =
      manual?.name ||
      auto?.displayName ||
      barbeiros.find((b) => foldName(b.nome) === key)?.nome ||
      key;

    // Linha Loja/Caixa da planilha não é profissional
    if (isStoreSpreadsheetRow(displayName)) continue;

    const autoCommission = auto?.auto ?? 0;
    const manualAmount = manual ? manual.amount : null;
    let source: BarberPeriodTotal['source'] = 'none';
    let final = 0;
    if (manualAmount != null) {
      source = 'manual';
      final = manualAmount;
    } else if (autoCommission > 0 || (auto?.count ?? 0) > 0) {
      source = 'automatic';
      final = autoCommission;
    }

    rows.push({
      profissional: displayName,
      paid_appointments_count: auto?.count ?? 0,
      faturamento_brl: Math.round((auto?.faturamento ?? 0) * 100) / 100,
      auto_commission_brl: Math.round(autoCommission * 100) / 100,
      manual_amount_brl: manualAmount,
      final_amount_brl: Math.round(final * 100) / 100,
      source,
    });
  }

  return rows.sort((a, b) => a.profissional.localeCompare(b.profissional, 'pt'));
}

/** Nomes que no CSV de merge representam o caixa da loja (não um barbeiro). */
const STORE_ROW_ALIASES = new Set([
  'loja',
  'caixa',
  'faturamento',
  'total',
  'store',
  'caixa da loja',
  'caixa loja',
  'faturamento loja',
]);

export function isStoreSpreadsheetRow(name: string): boolean {
  return STORE_ROW_ALIASES.has(foldName(name));
}

export type StoreInvoicingSummary = {
  barbeiros_equipe: number;
  barbeiros_com_movimento: number;
  paid_appointments: number;
  /** Soma price_brl dos pagos (valor dos serviços). */
  faturamento_servicos_brl: number;
  /** Bruto cobrado no Stripe (sinais + clube) — o que o cliente pagou. */
  bruto_stripe_brl: number;
  /** Taxa Wagoo estimada/registrada (2%). */
  taxa_wagoo_brl: number;
  /** Taxa Stripe estimada (cartão por padrão; clube = cartão). */
  taxa_stripe_brl: number;
  /**
   * Líquido que entra no caixa do salão = bruto − Wagoo − Stripe.
   * Não desconta comissão de barbeiro.
   */
  caixa_stripe_brl: number;
  sinais_bruto_brl: number;
  sinais_liquido_brl: number;
  clube_bruto_brl: number;
  clube_liquido_brl: number;
  /** Soma do que cada barbeiro ganhou (comissão/manual) — separado do caixa. */
  ganhos_barbeiros_brl: number;
  /**
   * Valor exibido como caixa da loja:
   * - líquido Stripe por padrão
   * - após planilha: linha Loja/Caixa se existir, senão soma da planilha
   */
  caixa_loja_brl: number;
  caixa_fonte: 'stripe' | 'planilha';
  planilha_total_brl: number | null;
  club_payments_count: number;
  /** Método usado na estimativa Stripe dos sinais (sem meio gravado). */
  stripe_fee_method: StripePaymentMethodFee;
};

function shopNetFromChargeBrl(
  chargedBrl: number,
  opts?: {
    applicationFeeBrl?: number | null;
    method?: StripePaymentMethodFee;
  },
): { bruto: number; wagoo: number; stripe: number; liquido: number } {
  const bruto = Math.max(0, Number(chargedBrl) || 0);
  if (bruto <= 0) return { bruto: 0, wagoo: 0, stripe: 0, liquido: 0 };
  const cents = brlToCents(bruto);
  const method = opts?.method ?? 'card';
  const est = estimateShopNetCents(cents, method);
  const wagooFromDb =
    opts?.applicationFeeBrl != null && Number(opts.applicationFeeBrl) >= 0
      ? Number(opts.applicationFeeBrl)
      : centsToBrl(computeApplicationFeeCents(cents));
  // Recalcula líquido com Wagoo real se houver
  const stripeFee = centsToBrl(est.stripeFeeCents);
  const liquido = Math.max(0, Math.round((bruto - wagooFromDb - stripeFee) * 100) / 100);
  return {
    bruto: Math.round(bruto * 100) / 100,
    wagoo: Math.round(wagooFromDb * 100) / 100,
    stripe: Math.round(stripeFee * 100) / 100,
    liquido,
  };
}

export function buildStoreInvoicingSummary(opts: {
  barbeirosCount: number;
  paidAppointments: PaidAppointmentForExport[];
  barbers: BarberPeriodTotal[];
  clubRevenueBrl: number;
  clubPaymentsCount: number;
  uploadedRows?: { profissional: string; valor: number }[];
  /** Estimativa de taxa Stripe nos sinais (default cartão). */
  stripeFeeMethod?: StripePaymentMethodFee;
}): StoreInvoicingSummary {
  const {
    barbeirosCount,
    paidAppointments,
    barbers,
    clubRevenueBrl,
    clubPaymentsCount,
    uploadedRows = [],
    stripeFeeMethod = 'card',
  } = opts;

  let faturamentoServicos = 0;
  let sinaisBruto = 0;
  let sinaisLiquido = 0;
  let taxaWagoo = 0;
  let taxaStripe = 0;

  for (const appt of paidAppointments) {
    faturamentoServicos += Number(appt.price_brl) || 0;
    const deposit = appt.deposit_amount_brl;
    // Só conta entrada real via Stripe (sinal cobrado)
    if (deposit == null || !(Number(deposit) > 0)) continue;
    const net = shopNetFromChargeBrl(Number(deposit), {
      applicationFeeBrl: appt.application_fee_brl,
      method: stripeFeeMethod,
    });
    sinaisBruto += net.bruto;
    sinaisLiquido += net.liquido;
    taxaWagoo += net.wagoo;
    taxaStripe += net.stripe;
  }

  const clubNet = shopNetFromChargeBrl(clubRevenueBrl, { method: 'card' });
  taxaWagoo += clubNet.wagoo;
  taxaStripe += clubNet.stripe;

  const brutoStripe = Math.round((sinaisBruto + clubNet.bruto) * 100) / 100;
  const caixaStripe = Math.round((sinaisLiquido + clubNet.liquido) * 100) / 100;

  const ganhosBarbeiros = Math.round(
    barbers.reduce((s, b) => s + b.final_amount_brl, 0) * 100,
  ) / 100;
  const comMovimento = barbers.filter(
    (b) => b.final_amount_brl > 0 || b.paid_appointments_count > 0,
  ).length;

  let caixaLoja = caixaStripe;
  let caixaFonte: 'stripe' | 'planilha' = 'stripe';
  let planilhaTotal: number | null = null;

  if (uploadedRows.length) {
    const storeRows = uploadedRows.filter((r) => isStoreSpreadsheetRow(r.profissional));
    const barberRows = uploadedRows.filter((r) => !isStoreSpreadsheetRow(r.profissional));
    const sumAll = uploadedRows.reduce((s, r) => s + (Number(r.valor) || 0), 0);
    const sumStore = storeRows.reduce((s, r) => s + (Number(r.valor) || 0), 0);
    const sumBarbers = barberRows.reduce((s, r) => s + (Number(r.valor) || 0), 0);
    planilhaTotal = Math.round(sumAll * 100) / 100;
    if (storeRows.length) {
      caixaLoja = Math.round(sumStore * 100) / 100;
    } else {
      caixaLoja = Math.round(sumBarbers * 100) / 100;
    }
    caixaFonte = 'planilha';
  }

  return {
    barbeiros_equipe: barbeirosCount,
    barbeiros_com_movimento: comMovimento,
    paid_appointments: paidAppointments.length,
    faturamento_servicos_brl: Math.round(faturamentoServicos * 100) / 100,
    bruto_stripe_brl: brutoStripe,
    taxa_wagoo_brl: Math.round(taxaWagoo * 100) / 100,
    taxa_stripe_brl: Math.round(taxaStripe * 100) / 100,
    caixa_stripe_brl: caixaStripe,
    sinais_bruto_brl: Math.round(sinaisBruto * 100) / 100,
    sinais_liquido_brl: Math.round(sinaisLiquido * 100) / 100,
    clube_bruto_brl: clubNet.bruto,
    clube_liquido_brl: clubNet.liquido,
    ganhos_barbeiros_brl: ganhosBarbeiros,
    caixa_loja_brl: caixaLoja,
    caixa_fonte: caixaFonte,
    planilha_total_brl: planilhaTotal,
    club_payments_count: clubPaymentsCount,
    stripe_fee_method: stripeFeeMethod,
  };
}

type Enrichment = {
  valorServico: string;
  statusPagamento: string;
  comissaoPercent: string;
  comissaoBrl: string;
  ganhoManualBrl: string;
  ganhoFinalBrl: string;
};

function emptyEnrichment(): Enrichment {
  return {
    valorServico: '',
    statusPagamento: '',
    comissaoPercent: '',
    comissaoBrl: '',
    ganhoManualBrl: '',
    ganhoFinalBrl: '',
  };
}

function enrichmentFromPaid(
  appt: PaidAppointmentForExport,
  barbeiros: Pick<BarbeiroRow, 'nome' | 'commission_percent'>[],
  manualMap: Map<string, { name: string; amount: number }>,
  totalsByKey: Map<string, BarberPeriodTotal>,
  professionalOverride?: string | null,
): Enrichment {
  const price = Number(appt.price_brl) || 0;
  const professional =
    professionalOverride?.trim() || professionalNameFromPaidAppt(appt) || '';
  const pct = resolveBarberCommissionPercent(barbeiros, professional || null);
  const commission = (price * pct) / 100;
  const key = foldName(professional || '(sem profissional)');
  const total = totalsByKey.get(key);
  const manual = manualMap.get(key);
  return {
    valorServico: moneyBr(price),
    statusPagamento: appt.payment_status,
    comissaoPercent: moneyBr(pct),
    comissaoBrl: moneyBr(commission),
    ganhoManualBrl: manual ? moneyBr(manual.amount) : '',
    ganhoFinalBrl: total ? moneyBr(total.final_amount_brl) : moneyBr(commission),
  };
}

function pickColumns(
  row: Record<AnalyticsExportColumn, string>,
  columns: AnalyticsExportColumn[],
): string {
  return columns.map((c) => csvEscape(row[c] ?? '')).join(',');
}

/**
 * CSV de agenda + colunas financeiras com override manual nos totais.
 */
export function eventsToCsvWithCommission(opts: {
  events: CalendarEventDto[];
  paidAppointments: PaidAppointmentForExport[];
  barbeiros: Pick<BarbeiroRow, 'nome' | 'commission_percent'>[];
  manualEntries?: ManualEarningsEntry[];
  columns?: AnalyticsExportColumn[];
  /** Linhas extras vindas do upload do dono (já parseadas). */
  uploadedRows?: { profissional: string; valor: number }[];
}): string {
  const {
    events,
    paidAppointments,
    barbeiros,
    manualEntries = [],
    columns = DEFAULT_ANALYTICS_EXPORT_COLUMNS,
    uploadedRows = [],
  } = opts;

  const cols = normalizeExportColumns(columns);
  const totals = buildBarberPeriodTotals({
    paidAppointments,
    barbeiros,
    manualEntries,
  });
  const totalsByKey = new Map(totals.map((t) => [foldName(t.profissional), t]));
  const manualMap = manualEarningsByName(manualEntries);

  // Upload sobrescreve manual no merge de totais (mesmo critério: substitui)
  if (uploadedRows.length) {
    for (const u of uploadedRows) {
      const name = u.profissional.trim();
      if (!name || isStoreSpreadsheetRow(name)) continue;
      const key = foldName(name);
      const amount = Math.round((Number(u.valor) || 0) * 100) / 100;
      manualMap.set(key, { name, amount });
      const existing = totalsByKey.get(key);
      totalsByKey.set(key, {
        profissional: name,
        paid_appointments_count: existing?.paid_appointments_count ?? 0,
        faturamento_brl: existing?.faturamento_brl ?? 0,
        auto_commission_brl: existing?.auto_commission_brl ?? 0,
        manual_amount_brl: amount,
        final_amount_brl: amount,
        source: 'manual',
      });
    }
  }

  const byGoogleId = new Map<string, PaidAppointmentForExport>();
  for (const appt of paidAppointments) {
    if (appt.google_event_id) byGoogleId.set(appt.google_event_id, appt);
  }

  const usedPaidIds = new Set<string>();
  const lines = [cols.join(',')];

  for (const ev of events) {
    const paid = byGoogleId.get(ev.id);
    let enrich = emptyEnrichment();
    if (paid) {
      usedPaidIds.add(paid.id);
      enrich = enrichmentFromPaid(
        paid,
        barbeiros,
        manualMap,
        totalsByKey,
        ev.barberName,
      );
    } else if (ev.barberName) {
      const key = foldName(ev.barberName);
      const total = totalsByKey.get(key);
      const manual = manualMap.get(key);
      if (manual || total) {
        enrich = {
          ...emptyEnrichment(),
          ganhoManualBrl: manual ? moneyBr(manual.amount) : '',
          ganhoFinalBrl: total ? moneyBr(total.final_amount_brl) : '',
        };
      }
    }

    const row: Record<AnalyticsExportColumn, string> = {
      data_inicio: ev.start,
      data_fim: ev.end,
      cliente: ev.clientName ?? '',
      telefone: ev.clientPhone ?? '',
      profissional: ev.barberName ?? '',
      titulo: ev.summary,
      origem: ev.source,
      valor_servico: enrich.valorServico,
      status_pagamento: enrich.statusPagamento,
      comissao_percent: enrich.comissaoPercent,
      comissao_brl: enrich.comissaoBrl,
      ganho_manual_brl: enrich.ganhoManualBrl,
      ganho_final_brl: enrich.ganhoFinalBrl,
    };
    lines.push(pickColumns(row, cols));
  }

  for (const appt of paidAppointments) {
    if (usedPaidIds.has(appt.id)) continue;
    const professional = professionalNameFromPaidAppt(appt);
    const enrich = enrichmentFromPaid(
      appt,
      barbeiros,
      manualMap,
      totalsByKey,
      professional,
    );
    const row: Record<AnalyticsExportColumn, string> = {
      data_inicio: appt.starts_at,
      data_fim: appt.ends_at,
      cliente: appt.client_name,
      telefone: appt.client_phone,
      profissional: professional,
      titulo: 'Agendamento pago (sem evento Google)',
      origem: 'pago',
      valor_servico: enrich.valorServico,
      status_pagamento: enrich.statusPagamento,
      comissao_percent: enrich.comissaoPercent,
      comissao_brl: enrich.comissaoBrl,
      ganho_manual_brl: enrich.ganhoManualBrl,
      ganho_final_brl: enrich.ganhoFinalBrl,
    };
    lines.push(pickColumns(row, cols));
  }

  // Totais finais (após merge upload)
  const finalTotals = [...totalsByKey.values()].sort((a, b) =>
    a.profissional.localeCompare(b.profissional, 'pt'),
  );

  lines.push('');
  lines.push('# totais_por_profissional');
  lines.push(
    [
      'profissional',
      'agendamentos_pagos',
      'faturamento_brl',
      'comissao_auto_brl',
      'ganho_manual_brl',
      'ganho_final_brl',
      'fonte',
    ].join(','),
  );
  for (const t of finalTotals) {
    lines.push(
      [
        csvEscape(t.profissional),
        String(t.paid_appointments_count),
        moneyBr(t.faturamento_brl),
        moneyBr(t.auto_commission_brl),
        t.manual_amount_brl != null ? moneyBr(t.manual_amount_brl) : '',
        moneyBr(t.final_amount_brl),
        t.source,
      ].join(','),
    );
  }

  return lines.join('\n');
}

/** Parse CSV simples (`,` ou `;`) com aliases de cabeçalho. */
export function parseEarningsUploadCsv(
  text: string,
): { ok: true; rows: { profissional: string; valor: number }[] } | { ok: false; error: string } {
  const raw = text.replace(/^\uFEFF/, '').trim();
  if (!raw) return { ok: false, error: 'Arquivo CSV vazio.' };

  const lines = raw.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (lines.length < 2) {
    return { ok: false, error: 'CSV precisa de cabeçalho e ao menos uma linha de dados.' };
  }

  const sep = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = !inQ;
        }
      } else if (ch === sep && !inQ) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };

  const header = split(lines[0]).map((h) => foldName(h));
  const nameAliases = new Set([
    'profissional',
    'barbeiro',
    'nome',
    'barber',
    'profissional_nome',
  ]);
  const valueAliases = new Set([
    'valor',
    'ganho',
    'comissao',
    'comissao_brl',
    'ganho_brl',
    'amount',
    'valor_brl',
  ]);

  let nameIdx = header.findIndex((h) => nameAliases.has(h));
  let valueIdx = header.findIndex((h) => valueAliases.has(h));
  if (nameIdx < 0) nameIdx = 0;
  if (valueIdx < 0) valueIdx = header.length > 1 ? 1 : -1;
  if (valueIdx < 0) {
    return {
      ok: false,
      error: 'Inclua colunas profissional e valor (ex.: profissional,valor).',
    };
  }

  const rows: { profissional: string; valor: number }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = split(lines[i]);
    const profissional = (cells[nameIdx] ?? '').trim();
    if (!profissional) continue;
    const rawVal = String(cells[valueIdx] ?? '')
      .replace(/R\$\s*/i, '')
      .trim();
    let valorRaw = rawVal;
    if (rawVal.includes(',') && rawVal.includes('.')) {
      // 1.200,50 → 1200.50
      valorRaw = rawVal.replace(/\./g, '').replace(',', '.');
    } else if (rawVal.includes(',')) {
      valorRaw = rawVal.replace(',', '.');
    }
    valorRaw = valorRaw.replace(/[^\d.-]/g, '');
    const valor = Number(valorRaw);
    if (!Number.isFinite(valor) || valor < 0) {
      return { ok: false, error: `Valor inválido na linha ${i + 1}.` };
    }
    rows.push({ profissional, valor });
  }

  if (!rows.length) {
    return { ok: false, error: 'Nenhuma linha válida encontrada no CSV.' };
  }
  return { ok: true, rows };
}

export function earningsTemplateCsv(): string {
  return (
    '# Abra no Excel. Preencha o que rolou no salão e envie de volta no Analytics.\n' +
    '# Use a linha Loja para o caixa da loja. As outras linhas são os profissionais.\n' +
    'profissional,valor\n' +
    'Loja,5000.00\n' +
    'João Silva,1200.00\n'
  );
}
