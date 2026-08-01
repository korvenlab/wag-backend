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

/** Converte catálogo booking_services → formato da IA (preços + duração). */
export function catalogToServicePrices(services: CatalogService[]): ServicePrice[] {
  return normalizeServicePrices(
    services.map((s) => ({
      name: s.name,
      price: `R$ ${Number(s.price_brl).toFixed(2).replace('.', ',')}`,
      notes: `${s.duration_minutes} min`,
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
  const all = matchCatalogServices(text, services);
  return all[0] ?? null;
}

/** Todos os serviços do catálogo citados no texto (ordem por relevância). */
export function matchCatalogServices(
  text: string,
  services: CatalogService[],
): CatalogService[] {
  if (!text?.trim() || !services.length) return [];
  const m = fold(text);
  const scored: { s: CatalogService; score: number }[] = [];

  for (const s of services) {
    const name = fold(s.name);
    if (!name) continue;
    let score = 0;
    if (m.includes(name)) {
      score = name.length + 100;
    } else {
      const tokens = name.split(/[\s/+-]+/).filter((t) => t.length >= 4);
      for (const t of tokens) {
        if (m.includes(t)) score = Math.max(score, t.length + 10);
      }
    }
    if (score > 0) scored.push({ s, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: CatalogService[] = [];
  for (const row of scored) {
    if (seen.has(row.s.id)) continue;
    seen.add(row.s.id);
    out.push(row.s);
  }
  return out;
}

/** Lista para WhatsApp: "1. Corte — R$ 50 (30 min)". */
export function formatCatalogListForWhatsApp(services: CatalogService[]): string {
  return services
    .map((s, i) => {
      const price = Number(s.price_brl).toFixed(2).replace('.', ',');
      return `${i + 1}. *${s.name}* — R$ ${price} (${s.duration_minutes} min)`;
    })
    .join('\n');
}

/** Resposta de preço: serviço(s) pedidos ou tabela completa. */
export function formatCatalogPriceReply(
  text: string,
  services: CatalogService[],
): string | null {
  if (!services.length) return null;
  const matched = matchCatalogServices(text, services);
  if (matched.length === 1) {
    const s = matched[0];
    const price = Number(s.price_brl).toFixed(2).replace('.', ',');
    return `*${s.name}*: R$ ${price} (${s.duration_minutes} min).`;
  }
  if (matched.length > 1) {
    return matched
      .map((s) => {
        const price = Number(s.price_brl).toFixed(2).replace('.', ',');
        return `*${s.name}*: R$ ${price} (${s.duration_minutes} min)`;
      })
      .join('\n');
  }
  return `Nossos serviços:\n\n${formatCatalogListForWhatsApp(services)}`;
}

/** Cliente pedindo preço / tabela / "quanto custa". */
export function isPriceInquiry(message: string): boolean {
  if (!message?.trim()) return false;
  const m = fold(message);
  if (/\b(preco|precos|valor|valores|tabela|cardapio|custa)\b/.test(m)) {
    return true;
  }
  if (/\bquanto\b/.test(m) && /\b(custa|fica|sai|cobram|cobra|e|sao)\b/.test(m)) {
    return true;
  }
  if (/^(quanto|valores?|precos?)\??$/.test(m)) return true;
  return false;
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
