export type ServicePrice = {
  name: string;
  price: string;
  notes?: string;
};

const MAX_ITEMS = 40;
const MAX_NAME = 80;
const MAX_PRICE = 40;
const MAX_NOTES = 120;

/**
 * Normaliza a lista de preços vinda do PostgREST / frontend.
 * Aceita array de objetos { name, price, notes? }.
 */
export function normalizeServicePrices(raw: unknown): ServicePrice[] {
  if (!Array.isArray(raw)) return [];
  const out: ServicePrice[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const src = item as Record<string, unknown>;
    const name = typeof src.name === 'string' ? src.name.trim().slice(0, MAX_NAME) : '';
    const price =
      typeof src.price === 'string'
        ? src.price.trim().slice(0, MAX_PRICE)
        : typeof src.price === 'number' && Number.isFinite(src.price)
          ? String(src.price).slice(0, MAX_PRICE)
          : '';
    if (!name || !price) continue;
    const notes =
      typeof src.notes === 'string' ? src.notes.trim().slice(0, MAX_NOTES) : '';
    const row: ServicePrice = { name, price };
    if (notes) row.notes = notes;
    out.push(row);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Verifica se a mensagem menciona algum serviço cadastrado
 * (ex.: "quanto o corte?" com item "Corte masculino").
 */
export function messageMentionsPricedService(
  message: string,
  prices: ServicePrice[],
): boolean {
  if (!message || !prices.length) return false;
  const m = fold(message);
  for (const p of prices) {
    const name = fold(p.name);
    if (!name) continue;
    if (m.includes(name)) return true;
    const tokens = name.split(/[\s/+-]+/).filter((t) => t.length >= 4);
    if (tokens.some((t) => m.includes(t))) return true;
  }
  return false;
}

/** Bloco de prompt: tabela de preços do dono para a IA. */
export function servicePricesPromptBlock(
  prices: ServicePrice[],
  nicheLabel?: string | null,
): string {
  const nicheBit = nicheLabel?.trim() ? ` (${nicheLabel.trim()})` : '';

  if (!prices.length) {
    return `
        PREÇOS / VALORES${nicheBit}:
        - O dono ainda NÃO cadastrou serviços com preço neste perfil (menu Serviços).
        - Se o cliente perguntar valor/preço/tabela: diga com naturalidade que confirma o valor na hora ou peça para perguntar na loja — sem inventar números.
        `;
  }

  const lines = prices.map((p, i) => {
    const note = p.notes ? ` — ${p.notes}` : '';
    return `${i + 1}. ${p.name}: ${p.price}${note}`;
  });

  return `
        PREÇOS / VALORES OFICIAIS${nicheBit} — FONTE ÚNICA do menu Serviços (obrigatório usar SEMPRE, com ou sem sinal/pagamento):
        ${lines.join('\n        ')}

        QUANDO O CLIENTE PERGUNTAR PREÇO / VALOR / TABELA / "QUANTO CUSTA":
        1. Busque nesta lista o serviço pedido (aceite nomes parciais: "corte" ≈ "Corte masculino", "barba", "unha", "escova", etc.).
        2. Responda com o valor cadastrado, curto e claro (ex.: "Corte masculino: *R$ 45* (30 min).").
        3. Se pedirem "valores" / "tabela" / "cardápio" / "preços" sem especificar: liste TODOS os itens acima com nome e preço (pode passar do limite curto de caracteres nesta resposta).
        4. Se pedirem dois ou mais serviços: informe o valor de cada um.
        5. NÃO invente preço que não esteja acima. Se não achar o serviço: diga que não tem esse valor cadastrado e cite a lista.
        6. Pedido de preço NÃO agenda sozinho — se couber, ofereça marcar horário depois numa frase curta.
        7. Use *negrito* WhatsApp nos valores e nomes dos serviços.
        8. Ao agendar, prefira o nome exacto do serviço desta lista.
        `;
}
