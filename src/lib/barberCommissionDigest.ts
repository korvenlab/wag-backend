import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { BR_TZ } from './dateTimeBR';
import { supabase } from './supabase';
import { log } from './logger';
import {
  generateCommissionShareToken,
  pickBarberTotalFromAnalytics,
} from './barberCommissionShare';
import { formatMoneyBrl } from './barberCommissionPayout';
import { buildAnalyticsSummaryPayload } from '../routes/analytics';
import { frontendBaseUrl } from './stripeClient';
import { digitsPhone } from '../services/clubMembership';
import { phoneVariants } from '../services/clubOtp';
import type { BarbeiroRow } from './barbeiros';

dayjs.extend(utc);
dayjs.extend(timezone);

const TAG = 'COMMISSION_DIGEST';
const TICK_MS = 15 * 60_000;
const SEND_GAP_MS = 1_500;
/** Segunda-feira = 1 no dayjs (0=domingo). */
const DIGEST_WEEKDAY = 1;
const DIGEST_HOUR_BR = 9;

export function previousWeekRangeIsoBR(now = dayjs().tz(BR_TZ)): {
  from: string;
  to: string;
  label: string;
} {
  const dow = now.day(); // 0=dom … 6=sáb
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  const thisMonday = now.startOf('day').subtract(daysSinceMonday, 'day');
  const prevMonday = thisMonday.subtract(7, 'day').startOf('day');
  const prevSunday = thisMonday.subtract(1, 'day').endOf('day');
  const label = `${prevMonday.format('DD/MM')} a ${prevSunday.format('DD/MM')}`;
  return {
    from: prevMonday.toISOString(),
    to: prevSunday.toISOString(),
    label,
  };
}

export function buildWeeklyCommissionWhatsAppMessage(opts: {
  profissional: string;
  weekLabel: string;
  finalAmountBrl: number;
  paidCount: number;
  shareUrl: string | null;
}): string {
  const money = formatMoneyBrl(opts.finalAmountBrl);
  const countBit =
    opts.paidCount > 0
      ? ` (${opts.paidCount} atendimento${opts.paidCount === 1 ? '' : 's'} pago${opts.paidCount === 1 ? '' : 's'})`
      : '';
  const linkBit = opts.shareUrl
    ? `\n\nDetalhes do mês: ${opts.shareUrl}`
    : '';
  return (
    `Oi ${opts.profissional}! Na semana ${opts.weekLabel} você faturou *${money}* de comissão${countBit}.` +
    linkBit
  );
}

async function ensureShareToken(barbeiro: BarbeiroRow): Promise<string | null> {
  if (barbeiro.commission_share_token) return barbeiro.commission_share_token;
  const token = generateCommissionShareToken();
  const { error } = await supabase
    .from('barbeiros')
    .update({ commission_share_token: token })
    .eq('id', barbeiro.id);
  if (error) {
    log.error(TAG, 'falha ao gerar token', error, { id: barbeiro.id });
    return null;
  }
  return token;
}

async function sendViaShopWhatsApp(
  ownerEmail: string,
  phone: string,
  text: string,
): Promise<boolean> {
  const { sessions } = await import('../services/whatsapp');
  const sock = sessions[ownerEmail];
  if (!sock?.user) return false;

  for (const variant of phoneVariants(phone)) {
    const jid = `${variant}@s.whatsapp.net`;
    try {
      await sock.sendMessage(jid, { text });
      return true;
    } catch {
      /* tenta próxima variante */
    }
  }
  return false;
}

export type DigestSendResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/**
 * Envia o resumo da semana anterior para um profissional (manual ou cron).
 */
export async function sendBarberWeeklyCommissionDigest(opts: {
  profileId: string;
  ownerEmail: string;
  barbeiro: BarbeiroRow;
  /** Se true, ignora o horário/segunda e o last_sent do dia. */
  force?: boolean;
}): Promise<DigestSendResult> {
  const phone = digitsPhone(opts.barbeiro.whatsapp_phone || '');
  if (!phone) {
    return { ok: false, error: 'Cadastre o WhatsApp do profissional.' };
  }
  if (!opts.barbeiro.commission_digest_enabled && !opts.force) {
    return { ok: false, error: 'Resumo semanal desligado para este profissional.' };
  }

  const now = dayjs().tz(BR_TZ);
  if (!opts.force) {
    const last = opts.barbeiro.commission_digest_last_sent_at
      ? dayjs(opts.barbeiro.commission_digest_last_sent_at).tz(BR_TZ)
      : null;
    if (last && last.isSame(now, 'day')) {
      return { ok: false, error: 'Resumo já enviado hoje.' };
    }
  }

  const week = previousWeekRangeIsoBR(now);
  const analytics = await buildAnalyticsSummaryPayload(
    opts.profileId,
    week.from,
    week.to,
  );
  const row = pickBarberTotalFromAnalytics(analytics.barbers, opts.barbeiro.nome);
  const finalAmount = row?.final_amount_brl ?? 0;
  const paidCount = row?.paid_appointments_count ?? 0;

  const token = await ensureShareToken(opts.barbeiro);
  const shareUrl = token ? `${frontendBaseUrl()}/comissao/${token}` : null;
  const message = buildWeeklyCommissionWhatsAppMessage({
    profissional: opts.barbeiro.nome,
    weekLabel: week.label,
    finalAmountBrl: finalAmount,
    paidCount,
    shareUrl,
  });

  const sent = await sendViaShopWhatsApp(opts.ownerEmail, phone, message);
  if (!sent) {
    return {
      ok: false,
      error: 'WhatsApp do salão offline ou número inválido.',
    };
  }

  await supabase
    .from('barbeiros')
    .update({ commission_digest_last_sent_at: new Date().toISOString() })
    .eq('id', opts.barbeiro.id);

  log.info(TAG, 'digest enviado', {
    barbeiroId: opts.barbeiro.id,
    amount: finalAmount,
    week: week.label,
  });

  return { ok: true, message };
}

async function processMondayDigests(): Promise<void> {
  const now = dayjs().tz(BR_TZ);
  if (now.day() !== DIGEST_WEEKDAY) return;
  if (now.hour() < DIGEST_HOUR_BR || now.hour() > DIGEST_HOUR_BR + 2) return;

  const dayStart = now.startOf('day').toISOString();

  const { data: rows, error } = await supabase
    .from('barbeiros')
    .select(
      'id, user_id, nome, google_calendar_email, ativo, commission_percent, commission_share_token, whatsapp_phone, commission_digest_enabled, commission_digest_last_sent_at, created_at',
    )
    .eq('ativo', true)
    .eq('commission_digest_enabled', true)
    .not('whatsapp_phone', 'is', null);

  if (error) {
    log.error(TAG, 'falha ao listar barbeiros', error);
    return;
  }
  if (!rows?.length) return;

  const profileIds = [...new Set(rows.map((r) => String(r.user_id)))];
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, email')
    .in('id', profileIds);

  const emailById = new Map(
    (profiles ?? []).map((p) => [String(p.id), String(p.email || '')]),
  );

  for (const raw of rows) {
    const last = raw.commission_digest_last_sent_at
      ? String(raw.commission_digest_last_sent_at)
      : null;
    if (last && last >= dayStart) continue;

    const ownerEmail = emailById.get(String(raw.user_id));
    if (!ownerEmail) continue;

    const barbeiro: BarbeiroRow = {
      id: String(raw.id),
      user_id: String(raw.user_id),
      nome: String(raw.nome),
      google_calendar_email: String(raw.google_calendar_email),
      ativo: Boolean(raw.ativo),
      commission_percent: Number(raw.commission_percent) || 0,
      commission_share_token: raw.commission_share_token
        ? String(raw.commission_share_token)
        : null,
      whatsapp_phone: raw.whatsapp_phone ? String(raw.whatsapp_phone) : null,
      commission_digest_enabled: true,
      commission_digest_last_sent_at: last,
    };

    const result = await sendBarberWeeklyCommissionDigest({
      profileId: barbeiro.user_id,
      ownerEmail,
      barbeiro,
    });
    if (!result.ok) {
      log.info(TAG, 'digest pulado', { id: barbeiro.id, error: result.error });
    }
    await new Promise((r) => setTimeout(r, SEND_GAP_MS));
  }
}

let workerStarted = false;

export function startCommissionDigestWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  log.info(TAG, 'worker iniciado', { tickMs: TICK_MS, hourBr: DIGEST_HOUR_BR });

  const tick = () => {
    void processMondayDigests().catch((err) =>
      log.error(TAG, 'tick falhou', err),
    );
  };

  setTimeout(tick, 20_000);
  setInterval(tick, TICK_MS);
}
