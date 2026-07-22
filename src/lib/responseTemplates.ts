export type ResponseTemplates = {
  saudacao?: string;
  apos_agendar?: string;
  ao_cancelar?: string;
  fora_horario?: string;
  notas_ia?: string;
};

const KEYS = [
  'saudacao',
  'apos_agendar',
  'ao_cancelar',
  'fora_horario',
  'notas_ia',
] as const;

const MAX_LEN = 800;

export function normalizeResponseTemplates(raw: unknown): ResponseTemplates {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: ResponseTemplates = {};
  for (const key of KEYS) {
    const v = src[key];
    if (typeof v !== 'string') continue;
    const trimmed = v.trim().slice(0, MAX_LEN);
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

/**
 * Guia de tom/personalidade para a IA — nunca script fixo.
 * A IA deve parafrasear e soar humana a cada mensagem.
 */
export function templatesPromptBlock(templates: ResponseTemplates): string {
  const lines: string[] = [];
  if (templates.notas_ia) {
    lines.push(`- Personalidade e jeito de falar (prioridade): ${templates.notas_ia}`);
  }
  if (templates.saudacao) {
    lines.push(`- Inspiração para cumprimento / abertura: ${templates.saudacao}`);
  }
  if (templates.apos_agendar) {
    lines.push(`- Inspiração ao confirmar horário: ${templates.apos_agendar}`);
  }
  if (templates.ao_cancelar) {
    lines.push(`- Inspiração ao cancelar: ${templates.ao_cancelar}`);
  }
  if (templates.fora_horario) {
    lines.push(`- Inspiração sem vaga / fora do horário: ${templates.fora_horario}`);
  }
  if (!lines.length) return '';

  return `
        ESTILO DE CONVERSA DO DONO (guia amplo — NÃO é script):
        ${lines.join('\n        ')}

        REGRAS OBRIGATÓRIAS SOBRE ESSE ESTILO:
        - Use só como direção de tom, carinho e personalidade — NUNCA copie o texto literal.
        - Cada resposta deve parecer improvisada por uma pessoa real: varíe palavras e ordem.
        - Evite soar robótica, repetitiva ou "de formulário".
        - Adapte ao contexto da mensagem do cliente (histórico, humor, urgência).
        - Pode misturar informalidade leve se o dono pedir; mantenha educação e clareza.
        - LIMITE RÍGIDO DE TAMANHO (mesmo com estilo personalizado): no máximo 1–2 frases curtas
          (ideal ≤160 caracteres; máximo ~220). O estilo muda o JEITO de falar, NÃO o comprimento.
        - Proibido: textos longos, vários parágrafos ou "ensaios" por causa do estilo do dono.
        - Natural e curto — como secretária no WhatsApp, não como FAQ nem carta.
        `;
}

/** Mensagens de sistema (cancelar/confirmar) ficam naturais — templates só guiam a IA. */
export function resolveCancelReply(
  _templates: ResponseTemplates | null | undefined,
  eventDateLabel: string,
): string {
  return `Pronto — cancelei seu horário de ${eventDateLabel}. Se quiser remarcar, é só falar.`;
}

export function resolveAfterBookingReply(
  _templates: ResponseTemplates | null | undefined,
  defaultText: string,
): string {
  return defaultText;
}
