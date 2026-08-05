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
import { supabase } from './supabase';

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

export type PublicScheduleAppointment = {
  id: string;
  starts_at: string;
  ends_at: string;
  day: string;
  time_label: string;
  client_name: string;
  service_name: string | null;
  price_brl: number;
  payment_status: string | null;
  status: string;
};

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
  /** Horários marcados com este profissional no mês (Agenda Web / app). */
  appointments: PublicScheduleAppointment[];
  /** Dias do mês (YYYY-MM-DD) que têm pelo menos 1 horário. */
  busy_days: string[];
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

/**
 * Agendamentos do mês atribuídos a este profissional (por nome do provider).
 * Sem Stripe — só dados da agenda/Analytics do salão.
 */
export async function loadBarberMonthAppointments(opts: {
  profileId: string;
  barberName: string;
  from: string;
  to: string;
}): Promise<PublicScheduleAppointment[]> {
  const key = foldName(opts.barberName);
  if (!key) return [];

  const { data, error } = await supabase
    .from('booking_appointments')
    .select(
      'id, starts_at, ends_at, client_name, price_brl, payment_status, status, booking_services(name), booking_providers(name)',
    )
    .eq('profile_id', opts.profileId)
    .in('status', ['confirmed', 'pending_payment', 'completed'])
    .gte('starts_at', opts.from)
    .lte('starts_at', opts.to)
    .order('starts_at', { ascending: true });

  if (error) {
    console.error('[commission-share] appointments:', error.message);
    return [];
  }

  const out: PublicScheduleAppointment[] = [];
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    const provider = r.booking_providers as { name?: string } | null | undefined;
    const service = r.booking_services as { name?: string } | null | undefined;
    const providerName = provider?.name ? String(provider.name) : '';
    if (foldName(providerName) !== key) continue;

    const starts = String(r.starts_at);
    const ends = String(r.ends_at);
    const startBr = dayjs(starts).tz(BR_TZ);
    const endBr = dayjs(ends).tz(BR_TZ);

    out.push({
      id: String(r.id),
      starts_at: starts,
      ends_at: ends,
      day: startBr.format('YYYY-MM-DD'),
      time_label: `${startBr.format('HH:mm')} – ${endBr.format('HH:mm')}`,
      client_name: String(r.client_name ?? '').trim() || 'Cliente',
      service_name: service?.name ? String(service.name) : null,
      price_brl: Number(r.price_brl) || 0,
      payment_status: r.payment_status != null ? String(r.payment_status) : null,
      status: String(r.status ?? 'confirmed'),
    });
  }

  return out;
}

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
  appointments?: PublicScheduleAppointment[];
}): PublicBarberCommissionPayload {
  const {
    barbeiro,
    storeName,
    year,
    month,
    paidAppointments,
    manualEntries,
    teamBarbeiros,
    appointments = [],
  } = opts;
  const key = foldName(barbeiro.nome);

  const rows = buildBarberPeriodTotals({
    paidAppointments,
    barbeiros: teamBarbeiros,
    manualEntries,
  });

  const mine = rows.find((r) => foldName(r.profissional) === key);
  const busy_days = [...new Set(appointments.map((a) => a.day))].sort();

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
    appointments,
    busy_days,
  };
}
