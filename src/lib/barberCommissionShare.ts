import crypto from 'crypto';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { BR_TZ } from './dateTimeBR';
import {
  buildBarberPeriodTotals,
  foldName,
  type ManualEarningsEntry,
  type PaidAppointmentForExport,
} from './csvCommissionExport';
import type { BarbeiroRow } from './barbeiros';

dayjs.extend(utc);
dayjs.extend(timezone);

export function generateCommissionShareToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** Intervalo ISO do mês civil em America/Sao_Paulo. */
export function monthRangeIsoBR(year: number, month: number): { from: string; to: string } {
  const ym = `${year}-${String(month).padStart(2, '0')}-01`;
  const start = dayjs.tz(ym, BR_TZ).startOf('day');
  const end = start.endOf('month');
  return { from: start.toISOString(), to: end.toISOString() };
}

export function currentYearMonthBR(): { year: number; month: number } {
  const now = dayjs().tz(BR_TZ);
  return { year: now.year(), month: now.month() + 1 };
}

export type PublicBarberCommissionPayload = {
  profissional: string;
  store_name: string | null;
  period: { year: number; month: number; label: string };
  commission_percent: number;
  paid_appointments_count: number;
  faturamento_brl: number;
  auto_commission_brl: number;
  manual_amount_brl: number | null;
  /** Valor final do mês (planilha/manual tem prioridade sobre comissão automática). */
  final_amount_brl: number;
  source: 'automatic' | 'manual' | 'none';
};

const MONTH_LABELS = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];

export function buildPublicBarberCommission(opts: {
  barbeiro: BarbeiroRow;
  storeName: string | null;
  year: number;
  month: number;
  paidAppointments: PaidAppointmentForExport[];
  /** Só entradas deste barbeiro (já filtradas) ou todas — filtra por nome. */
  manualEntries: ManualEarningsEntry[];
  /** Lista completa da equipe só para % de comissão por nome. */
  teamBarbeiros: BarbeiroRow[];
}): PublicBarberCommissionPayload {
  const { barbeiro, storeName, year, month, paidAppointments, manualEntries, teamBarbeiros } =
    opts;
  const key = foldName(barbeiro.nome);

  const rows = buildBarberPeriodTotals({
    paidAppointments,
    barbeiros: teamBarbeiros,
    manualEntries,
  });

  const mine = rows.find((r) => foldName(r.profissional) === key);

  return {
    profissional: barbeiro.nome,
    store_name: storeName,
    period: {
      year,
      month,
      label: `${MONTH_LABELS[month - 1] ?? month} de ${year}`,
    },
    commission_percent: barbeiro.commission_percent,
    paid_appointments_count: mine?.paid_appointments_count ?? 0,
    faturamento_brl: mine?.faturamento_brl ?? 0,
    auto_commission_brl: mine?.auto_commission_brl ?? 0,
    manual_amount_brl: mine?.manual_amount_brl ?? null,
    final_amount_brl: mine?.final_amount_brl ?? 0,
    source: mine?.source ?? 'none',
  };
}
