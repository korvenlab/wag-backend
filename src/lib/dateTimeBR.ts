import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

export const BR_TZ = 'America/Sao_Paulo';

/** Formata ISO/offset para data+hora no fuso do Brasil (Render roda em UTC). */
export function formatDateTimeBR(
  value: string | Date,
  pattern = 'DD/MM/YYYY, HH:mm',
): string {
  return dayjs(value).tz(BR_TZ).format(pattern);
}

export function formatTimeBR(value: string | Date): string {
  return dayjs(value).tz(BR_TZ).format('HH:mm');
}

/**
 * Cliente perguntando quem está livre / quais profissionais — NÃO é confirmação de marca.
 */
export function isAskingProfessionalAvailability(message: string): boolean {
  const m = message.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const asksWho =
    /qual(?:es)?\s+(?:barbeiro|profissional|atendente|pessoa)/.test(m) ||
    /quem\s+(?:esta|vai|pode|atende)/.test(m) ||
    /(?:barbeiro|profissional).*(?:disponivel|livre)/.test(m) ||
    /(?:disponivel|livre).*(?:barbeiro|profissional)/.test(m);
  return asksWho;
}

/** "Sim / confirma / pode marcar" — libera o agendamento pendente. */
export function isAffirmativeBooking(message: string): boolean {
  const m = message.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim();
  if (isAskingProfessionalAvailability(message)) return false;
  if (isNegativeBooking(message)) return false;
  // Evita "pode ser 10h" (nova proposta) ser tratado só como sim.
  if (/\d/.test(m) && /\b(h|hora|:)\b/.test(m)) return false;
  return (
    /^(sim|s|yes|ok|okay|certo|isso|fechado|confirmo|confirma|pode|claro|perfeito|combinado)\b/.test(m) ||
    /\b(pode marcar|pode agendar|pode confirmar|esta confirmado|tá bom|ta bom|isso mesmo|fechamos)\b/.test(m)
  );
}

/** Cliente desiste / pede outro horário. */
export function isNegativeBooking(message: string): boolean {
  const m = message.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim();
  return (
    /^(nao|no|nop)\b/.test(m) ||
    /\b(nao quero|pode cancelar|outro horario|outra hora|muda|troca|desisti)\b/.test(m)
  );
}

/**
 * Confirmação explícita de horário (não só menção genérica).
 * Ex.: "pode ser 9h", "quero as 14h", "confirma 16h".
 */
export function looksLikeTimeConfirmation(message: string): boolean {
  const m = message.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  if (isAskingProfessionalAvailability(message)) return false;
  return (
    /\b(\d{1,2})\s*h(?:oras?)?\b/.test(m) ||
    /\b(\d{1,2}):(\d{2})\b/.test(m) ||
    /\bas\s+\d{1,2}/.test(m) ||
    /\b(pode ser|quero|marca|confirma|esse|esse horario|neste)\b/.test(m)
  );
}

/** 09:00 → 9h | 09:30 → 9h30 */
export function formatHourCompact(value: string | Date | dayjs.Dayjs): string {
  const d = dayjs.isDayjs(value) ? value.tz(BR_TZ) : dayjs(value).tz(BR_TZ);
  const h = d.hour();
  const m = d.minute();
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
}

const WEEKDAY_KEYS = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
] as const;

export function weekdayKeyBR(dayIso: string): string {
  return WEEKDAY_KEYS[dayjs(dayIso).tz(BR_TZ).day()];
}

type DayHours = {
  startTime?: string;
  endTime?: string;
  isTurno1Active?: boolean;
  startTime2?: string;
  endTime2?: string;
  isTurno2Active?: boolean;
  startTime3?: string;
  endTime3?: string;
  isTurno3Active?: boolean;
};

function parseHm(hm: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}

/** Janelas ativas do dia a partir de working_hours do perfil. */
export function dayWindowsFromWorkingHours(
  workingHours: unknown,
  dayIso: string,
): Array<{ startHm: string; endHm: string }> {
  if (!workingHours || typeof workingHours !== 'object') return [];
  const key = weekdayKeyBR(dayIso);
  const day = (workingHours as Record<string, DayHours>)[key];
  if (!day) return [];

  const out: Array<{ startHm: string; endHm: string }> = [];
  const push = (active: boolean | undefined, start?: string, end?: string, defaultActive = true) => {
    if ((active ?? defaultActive) && start && end) out.push({ startHm: start, endHm: end });
  };
  push(day.isTurno1Active, day.startTime, day.endTime, true);
  push(day.isTurno2Active, day.startTime2, day.endTime2, true);
  push(day.isTurno3Active, day.startTime3, day.endTime3, false);
  return out;
}

/**
 * Agrupa slots livres consecutivos em intervalos: "9h–11h30, 14h–17h".
 * `slotStarts` = horários de início livres (ordenado), passo = duração do serviço.
 */
export function collapseSlotsToRanges(
  slotStarts: dayjs.Dayjs[],
  durationMin: number,
): string {
  if (!slotStarts.length) return 'nenhum horário livre';

  const ranges: Array<{ from: dayjs.Dayjs; to: dayjs.Dayjs }> = [];
  let from = slotStarts[0];
  let prev = slotStarts[0];

  for (let i = 1; i < slotStarts.length; i++) {
    const cur = slotStarts[i];
    if (cur.diff(prev, 'minute') === durationMin) {
      prev = cur;
      continue;
    }
    ranges.push({ from, to: prev.add(durationMin, 'minute') });
    from = cur;
    prev = cur;
  }
  ranges.push({ from, to: prev.add(durationMin, 'minute') });

  return ranges
    .map((r) => `${formatHourCompact(r.from)}–${formatHourCompact(r.to)}`)
    .join(', ');
}
