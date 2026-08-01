import { normalizeServicePrices, type ServicePrice } from './servicePrices';

export type CatalogService = {
  id: string;
  name: string;
  price_brl: number;
  duration_minutes: number;
  active?: boolean | null;
};

function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/** Converte catálogo booking_services → formato legado da IA (preços). */
export function catalogToServicePrices(services: CatalogService[]): ServicePrice[] {
  return normalizeServicePrices(
    services.map((s) => ({
      name: s.name,
      price: `R$ ${Number(s.price_brl).toFixed(2).replace('.', ',')}`,
    })),
  );
}

/**
 * Encontra serviço do catálogo mencionado no texto (nome completo ou token ≥4 chars).
 */
export function matchCatalogService(
  text: string,
  services: CatalogService[],
): CatalogService | null {
  if (!text?.trim() || !services.length) return null;
  const m = fold(text);
  let best: CatalogService | null = null;
  let bestScore = 0;

  for (const s of services) {
    const name = fold(s.name);
    if (!name) continue;
    if (m.includes(name)) {
      const score = name.length + 100;
      if (score > bestScore) {
        best = s;
        bestScore = score;
      }
      continue;
    }
    const tokens = name.split(/[\s/+-]+/).filter((t) => t.length >= 4);
    for (const t of tokens) {
      if (m.includes(t) && t.length + 10 > bestScore) {
        best = s;
        bestScore = t.length + 10;
      }
    }
  }
  return best;
}

/** Lista curta para WhatsApp: "1. Corte — R$ 50 (30 min)". */
export function formatCatalogListForWhatsApp(services: CatalogService[]): string {
  return services
    .slice(0, 12)
    .map((s, i) => {
      const price = Number(s.price_brl).toFixed(2).replace('.', ',');
      return `${i + 1}. *${s.name}* — R$ ${price} (${s.duration_minutes} min)`;
    })
    .join('\n');
}

export function parseAiBookingNotes(notes: string | null | undefined): {
  source: 'ai' | 'agenda_web' | null;
  barberName: string | null;
  barberEmail: string | null;
} {
  const raw = String(notes || '');
  const source = /source=ai\b/i.test(raw)
    ? 'ai'
    : /source=agenda_web\b/i.test(raw)
      ? 'agenda_web'
      : null;
  const barberName = raw.match(/barberName=([^|]+)/i)?.[1]?.trim() || null;
  const barberEmail = raw.match(/barberEmail=([^|]+)/i)?.[1]?.trim() || null;
  return { source, barberName, barberEmail };
}

export function buildAiBookingNotes(input: {
  barberName?: string | null;
  barberEmail?: string | null;
  extra?: string;
}): string {
  const parts = ['source=ai'];
  if (input.barberName?.trim()) parts.push(`barberName=${input.barberName.trim()}`);
  if (input.barberEmail?.trim()) parts.push(`barberEmail=${input.barberEmail.trim()}`);
  if (input.extra?.trim()) parts.push(input.extra.trim());
  return parts.join(' | ');
}
