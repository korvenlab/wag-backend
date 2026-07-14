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
