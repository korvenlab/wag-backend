import { GoogleGenerativeAI, type GenerateContentResult } from "@google/generative-ai";
import dotenv from 'dotenv';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { resolveNicheVocabulary } from '../lib/businessNiche';
import { templatesPromptBlock, type ResponseTemplates } from '../lib/responseTemplates';
import {
  messageMentionsPricedService,
  normalizeServicePrices,
  servicePricesPromptBlock,
  type ServicePrice,
} from '../lib/servicePrices';
import { log } from '../lib/logger';
import { isAskingProfessionalAvailability } from '../lib/dateTimeBR';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("America/Sao_Paulo");

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() ?? '';

/** Primário: gemini-3.1-flash-lite (Render). Fallback se a API falhar. */
const DEFAULT_GEMINI_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
] as const;

function isLeakedApiKeyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('leaked') || msg.includes('API key was reported');
}

function resolveModelCandidates(): string[] {
  const fromEnv = process.env.GEMINI_MODEL?.trim();
  const ordered = fromEnv ? [fromEnv, ...DEFAULT_GEMINI_MODELS] : [...DEFAULT_GEMINI_MODELS];
  return [...new Set(ordered.filter(Boolean))];
}

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

export type ActiveBarbeiroForAi = { id: string; nome: string };

export type SchedulingBarberState = {
  barberConfirmed: boolean;
  selectedBarberName: string | null;
};

/** Cenário B: mais de um barbeiro activo — exige escolha de profissional. */
export const isMultiBarberTeam = (activeBarbeiros: ActiveBarbeiroForAi[]): boolean =>
  activeBarbeiros.length > 1;

/**
 * Gate para ABRIR conversa com a IA (mensagem sem sessão activa).
 * Tem de ser estrito: "hoje"/"amanhã"/qualquer dígito sozinhos NÃO bastam
 * (ex.: "vou na academia hoje" não é pedido de horário).
 * Dentro de sessão activa, o WhatsApp aceita "19", "Marcos", "sim" sem isto.
 * `knownServiceNames` = nomes da tabela de preços do perfil (abre se o cliente citar o serviço).
 */
export const hasSchedulingIntent = (
  message: string,
  knownServiceNames: string[] = [],
): boolean => {
    if (!message) return false;
    const m = message
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
    if (!m) return false;

    const strong = [
      'agendar',
      'marcar',
      'marcacao',
      'horario',
      'agenda',
      'vaga',
      'disponivel',
      'reservar',
      'desmarcar',
      'cancelar',
      'reagendar',
      'remarcar',
      'remarcacao',
      // Preços / valores
      'preco',
      'precos',
      'valor',
      'valores',
      'tabela',
      'cardapio',
      'custa',
      'quanto fica',
      'quanto e',
      'quanto custa',
    ];
    if (strong.some((k) => m.includes(k))) return true;
    if (/\bquanto\b/.test(m) && /\b(custa|fica|sai|cobram|cobra)\b/.test(m)) return true;

    if (
      messageMentionsPricedService(
        message,
        knownServiceNames.map((name) => ({ name, price: '1' })),
      )
    ) {
      return true;
    }

    const services = [
      'barbeiro',
      'profissional',
      'corte',
      'cabelo',
      'barba',
      'manicure',
      'unha',
      'unhas',
      'escova',
      'estetica',
      'sessao',
      'coloracao',
      'progressiva',
      'hidratacao',
      'luzes',
      'mechas',
      'pedicure',
      'alongamento',
      'depilacao',
      'sobrancelha',
      'massagem',
      'peeling',
    ];
    if (services.some((k) => m.includes(k))) return true;

    const hasDayWord =
      /\b(hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/.test(m);
    const hasClock =
      /\b([01]?\d|2[0-3])\s*h([0-5]\d)?\b/.test(m) ||
      /\b([01]?\d|2[0-3]):[0-5]\d\b/.test(m);
    const hasIntentVerb =
      /\b(quero|queria|preciso|da pra|da para)\b/.test(m) ||
      /\btem\s+(vaga|horario|hora|disponibilidade)\b/.test(m) ||
      /\bpode\s+(marcar|agendar|ser)\b/.test(m);

    if (hasDayWord && (hasClock || hasIntentVerb || services.some((k) => m.includes(k)))) {
      return true;
    }
    if (hasClock && hasIntentVerb) return true;

    return false;
};

type AiJsonPayload = {
  isScheduling?: boolean;
  isCancelling?: boolean;
  extractedDate?: string | null;
  extractedTime?: string | null;
  barberSelection?: string | null;
  barberConfirmed?: boolean;
  response?: string;
};

function extractResponseText(result: GenerateContentResult): string {
  const response = result.response;
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    throw new Error(`Gemini bloqueou o prompt: ${blockReason}`);
  }

  let text = '';
  try {
    text = response.text()?.trim() ?? '';
  } catch {
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    text = parts
      .map((p) => ('text' in p && typeof p.text === 'string' ? p.text : ''))
      .join('')
      .trim();
  }

  if (!text) {
    const finish = response.candidates?.[0]?.finishReason ?? 'desconhecido';
    throw new Error(`Resposta vazia do Gemini (finishReason=${finish})`);
  }

  return text;
}

function parseAiJson(raw: string): AiJsonPayload {
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();

  try {
    return JSON.parse(cleaned) as AiJsonPayload;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('JSON inválido na resposta da IA');
    return JSON.parse(match[0]) as AiJsonPayload;
  }
}

async function callGemini(prompt: string, modelName: string): Promise<AiJsonPayload> {
  if (!genAI) throw new Error('GEMINI_API_KEY não configurada no servidor');

  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 512,
      responseMimeType: 'application/json',
    },
  });

  const result = await model.generateContent(prompt);
  const text = extractResponseText(result);
  return parseAiJson(text);
}

async function callGeminiWithFallback(prompt: string): Promise<AiJsonPayload> {
  const models = resolveModelCandidates();
  let lastError: unknown;

  for (const modelName of models) {
    try {
      const parsed = await callGemini(prompt, modelName);
      return parsed;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (isLeakedApiKeyError(err)) {
        console.error(
          '[WAGOO AI] CRÍTICO: GEMINI_API_KEY revogada (vazamento detectado pelo Google). ' +
            'Gere uma nova chave em https://aistudio.google.com/apikey e atualize no Render.',
        );
        throw err;
      }
      console.warn(`[WAGOO AI] Falha com modelo ${modelName}: ${msg}`);
    }
  }

  throw lastError ?? new Error('Nenhum modelo Gemini disponível');
}

export const analyzeMessage = async (
    history: string,
    currentMessage: string,
    isAiEnabled: boolean,
    isGroup: boolean,
    busySlots: string[],
    dbRow: {
        store_name: string,
        working_hours: unknown,
        service_duration: number,
        business_niche?: string | null,
        business_niche_custom?: string | null,
        service_prices?: ServicePrice[] | unknown,
        free_ranges_summary?: string | null,
        response_templates?: ResponseTemplates | null,
        is_first_reply?: boolean,
        should_greet?: boolean,
        time_greeting?: string | null,
        ai_use_emojis?: boolean,
    },
    activeBarbeiros: ActiveBarbeiroForAi[] = [],
    schedulingState: SchedulingBarberState = { barberConfirmed: false, selectedBarberName: null },
) => {

    if (isGroup || !isAiEnabled) {
        return {
            isScheduling: false,
            isCancelling: false,
            response: null,
            date: null as string | null,
            extractedDate: null as string | null,
            extractedTime: null as string | null,
            barberSelection: null as string | null,
            barberConfirmed: false,
            canConfirmSchedule: false,
            askingProfessionalAvailability: false,
        };
    }

    if (!GEMINI_API_KEY) {
        console.error('[WAGOO AI] GEMINI_API_KEY ausente — configure no Render');
        return {
            isScheduling: false,
            isCancelling: false,
            response: 'No momento não consigo processar mensagens. A equipa foi avisada.',
            date: null,
            extractedDate: null,
            extractedTime: null,
            barberSelection: null,
            barberConfirmed: false,
            canConfirmSchedule: false,
            askingProfessionalAvailability: false,
        };
    }

    try {
        const multiBarber = isMultiBarberTeam(activeBarbeiros);
        const singleBarberName =
            activeBarbeiros.length === 1 ? activeBarbeiros[0].nome : null;

        const agoraBR = dayjs().tz("America/Sao_Paulo");
        const currentTimeBR = agoraBR.format('HH:mm');
        const dataFormatadaBR = agoraBR.format('DD/MM/YYYY');
        const diaAtualNome = agoraBR.format('dddd');
        const niche = resolveNicheVocabulary(dbRow.business_niche, dbRow.business_niche_custom);
        const storeLabel = dbRow.store_name?.trim() || niche.defaultStoreName;
        const { professional, professionals, businessType } = niche;

        const teamBlock = multiBarber
            ? `
        CENÁRIO B — MÚLTIPLOS PROFISSIONAIS (${activeBarbeiros.length} activos):
        Equipe: ${activeBarbeiros.map((b) => b.nome).join(', ')}
        Opção extra: "Sem Preferência".

        Estado: ${professional} confirmado=${schedulingState.barberConfirmed ? 'SIM' : 'NÃO'}; escolha=${schedulingState.selectedBarberName ?? '—'}

        REGRAS:
        1. Intenção de agendar → pergunte ${professional} OU "Sem Preferência" (numa frase).
        2. Cliente não conhece a equipe → cite só os nomes, sem descrições.
        3. Sem barberConfirmed=true: não sugira horários nem confirme marcação.
        4. Com ${professional} escolhido → horários livres compactos (use OCUPADOS).
        5. "Sem Preferência" → horários mais cedo (SUGESTOES_SEM_PREFERENCIA se houver).
        6. barberSelection = nome exacto ou SEM_PREFERENCIA; barberConfirmed=true só após escolha explícita.
        7. Se o cliente pergunta "qual ${professional} está disponível" num horário: isScheduling=false, liste quem está livre (use OCUPADOS) e peça a escolha — NÃO confirme marcação.
        8. Nunca marque sozinho: o sistema pede "Posso confirmar…?" e só agenda após o cliente dizer sim.
        9. Ao listar horários, USE o campo LIVRES_RESUMO (Manhã/Tarde/Noite). Preserve as quebras de linha.
        10. isScheduling=true SÓ quando o cliente confirmar uma proposta já feita (sim/confirma/pode marcar).
        `
            : `
        CENÁRIO A — UM PROFISSIONAL${singleBarberName ? ` (${singleBarberName})` : ''}:
        - Não pergunte ${professional} nem liste equipe.
        - Vá directo a dia/horário disponível (use LIVRES_RESUMO com Manhã/Tarde/Noite).
        - barberConfirmed=true com intenção de agendar; barberSelection=null.
        - Nunca marque sozinho — sempre peça confirmação; isScheduling=true só após o "sim".
        `;

        const busyContext = multiBarber && !schedulingState.barberConfirmed
            ? `Aguardando escolha do ${professional}.`
            : busySlots.join(', ') || 'nenhum';

        const freeRangesHint = dbRow.free_ranges_summary?.trim() || '';
        const templatesBlock = templatesPromptBlock(dbRow.response_templates ?? {});
        const prices = normalizeServicePrices(dbRow.service_prices);
        const pricesBlock = servicePricesPromptBlock(prices, niche.label);
        const emojiBlock = dbRow.ai_use_emojis
          ? `
        EMOJIS (ativos — use de forma natural e amigável):
        - Prefira incluir emoji na maioria das respostas curtas (cumprimento, confirmação, pergunta).
        - Tom WhatsApp humano: 😊 🙂 👍 🙏 ✨ 👋 — encaixe no final da frase ou no cumprimento.
        - Moderação: 1–2 por mensagem costuma bastar; no máximo 3. Nunca encha a mensagem de emoji.
        - NUNCA coloque emoji dentro da lista de horários (Manhã/Tarde/Noite).
        - Exemplos de tom: "Bom dia! 😊\\n\\nQual horário prefere?" | "Posso confirmar amanhã às 15h? 👍"
        `
          : `
        EMOJIS: proibidos. Não use nenhum emoji, emoticon ou símbolo decorativo.
        `;
        const firstReplyBlock = dbRow.should_greet || dbRow.is_first_reply
          ? `
        CUMPRIMENTO NESTA RESPOSTA (obrigatório — sempre retribuir):
        - O cliente saudou OU é a primeira mensagem. SEMPRE comece retribuindo com "${dbRow.time_greeting || 'Olá'}!".
        - Depois continue a resposta útil (horários, pergunta, etc.).
        - Ex.: "Boa noite!\\n\\nAmanhã:\\nManhã: 09:00 / 10:00\\n\\nQual horário prefere?"
        `
          : `
        Continuação: NÃO cumprimente de novo — só retribuir se o cliente saudar (Bom dia/Boa tarde/Boa noite/Oi).
        `;

        const prompt = `
        Você é o Wagoo, secretária virtual da "${storeLabel}" (${businessType}) no WhatsApp.
        Extraia intenção de agendamento e escolha de ${professional}.

        NICHO DO NEGÓCIO (obrigatório respeitar):
        - Tipo: ${businessType} (${niche.label})
        - Singular: "${professional}" | Plural: "${professionals}"
        - Nunca diga "barbeiro", "barbeiros" ou "barbearia" salvo se o nicho for barbearia.
        - Nunca invente outro tipo de negócio.
        ${pricesBlock}
        ${templatesBlock}
        ${emojiBlock}
        ${firstReplyBlock}
        ESTILO DO CAMPO "response" (obrigatório):
        - Cordial, humana e amigável — como secretária real no WhatsApp, nunca robótica ou de FAQ.
        - Varie o jeito de falar a cada mensagem (sinônimos, ordem, ritmo); não repita a mesma fórmula.
        - SEMPRE 1–2 frases curtas no corpo (ideal ≤160 caracteres; máximo ~220), além do cumprimento inicial se houver.
        - Cordialidade enxuta: "Por favor", "Obrigada" quando couber — sem bajulação.
        - Proibido: elogios longos ("excelente profissional", "ótima escolha"), parágrafos, repetir o pedido do cliente.
        - Proibido: respostas que pareçam copiadas de um template ou menu.

        FIDELIDADE AO QUE O CLIENTE PEDIU (prioridade máxima):
        - Respeite SEMPRE o dia, horário, período (manhã/tarde/noite) e profissional que o cliente falou.
        - Nunca troque "amanhã" por "hoje", nem invente outro dia/hora sem o cliente pedir.
        - Se LIVRES_RESUMO existir, PRESERVE o layout (dia + Manhã/Tarde/Noite). Deixe UMA linha em branco entre Manhã, Tarde e Noite. Não amasse tudo numa frase.
        - Formato ideal ao listar vagas (horários e dia em *negrito* WhatsApp):
          *Amanhã*:
          Manhã: *08:00* / *09:00* / *10:00*

          Tarde: *13:00* / *14:00* / *15:00*

          Qual horário prefere?
        - Se o pedido não couber (sem vaga), diga isso no dia pedido e ofereça alternativa — sem fingir que era outro dia.
        - Uma pergunta por vez.
        - NUNCA escreva "Confirmado:" — o sistema confirma depois do "sim" do cliente.
        - Quando o cliente escolher um horário, peça confirmação de forma natural no dia certo (ex.: "Posso marcar *amanhã* às *15h*?").
        - isScheduling=true SOMENTE se o cliente já afirmou (sim/confirma/pode marcar) sobre uma proposta.
        - Exemplos de tom (não copie literalmente): "*Amanhã* de manhã tem *9h* e *10h* — qual prefere?" | "Fecho *amanhã* às *15h* então?" | "Temos o *Marcos* e o *Robson* — prefere algum?"

        NEGRITO WHATSAPP (obrigatório no campo "response"):
        - Sempre destaque com *asteriscos* (um de cada lado) horários, datas e nomes de pessoas.
        - Horários: *08:00*, *15h*, *14:30*
        - Datas/dias: *hoje*, *amanhã*, *22/07*, *segunda*
        - Nomes de profissionais/clientes: *Marcos*, *Ana*
        - Não use **markdown duplo** — no WhatsApp o negrito é *assim*.
        - Não coloque negrito em palavras comuns (só horário, data e nome).

        EXTRAÇÃO:
        - DATA (YYYY-MM-DD) e HORA (HH:mm) quando o cliente escolher um horário (mesmo antes do sim final).
        - Hoje: ${diaAtualNome}, ${dataFormatadaBR} ${currentTimeBR} (fuso America/Sao_Paulo).
        - Serviço: ${dbRow.service_duration ?? 30} min.
        - Horários abaixo já estão em Brasília.

        OCUPADOS: ${busyContext}
        LIVRES_RESUMO: ${freeRangesHint || 'calcule com HORÁRIOS LOJA − OCUPADOS, agrupando Manhã/Tarde/Noite'}
        HORÁRIOS LOJA: ${JSON.stringify(dbRow.working_hours ?? {})}
        ${teamBlock}

        HISTÓRICO:
        ${history}

        MENSAGEM:
        "${currentMessage}"

        JSON válido apenas (sem markdown de código; *negrito* WhatsApp no campo response é obrigatório):
        {
            "isScheduling": boolean,
            "isCancelling": boolean,
            "extractedDate": "YYYY-MM-DD ou null",
            "extractedTime": "HH:mm ou null",
            "barberSelection": "nome exacto, SEM_PREFERENCIA ou null",
            "barberConfirmed": boolean,
            "response": "Resposta curta, cordial, em português do Brasil, com *horários* *datas* e *nomes* em negrito"
        }`;

        const parsed = await callGeminiWithFallback(prompt);

        let barberConfirmed = Boolean(parsed.barberConfirmed);
        let barberSelection: string | null =
            typeof parsed.barberSelection === 'string' && parsed.barberSelection.trim()
                ? parsed.barberSelection.trim()
                : null;

        if (schedulingState.barberConfirmed && schedulingState.selectedBarberName) {
            barberConfirmed = true;
            barberSelection = schedulingState.selectedBarberName;
        } else if (barberSelection) {
            const norm = barberSelection.toLowerCase();
            if (norm.includes('sem prefer')) {
                barberSelection = 'SEM_PREFERENCIA';
            }
            const match = activeBarbeiros.find(
                (b) => b.nome.toLowerCase() === barberSelection!.toLowerCase(),
            );
            if (match) barberSelection = match.nome;
            barberConfirmed = true;
        }

        if (!multiBarber) {
            barberConfirmed = true;
            barberSelection = singleBarberName;
        }

        const canConfirmSchedule = !multiBarber || barberConfirmed;

        let finalIsoDate: string | null = null;
        const wantsSchedule = Boolean(parsed.isScheduling);
        const askingWho = isAskingProfessionalAvailability(currentMessage);

        // Extrai proposta de data/hora mesmo antes do "sim" (para pedir confirmação no sistema).
        if (
            canConfirmSchedule &&
            !askingWho &&
            parsed.extractedDate &&
            parsed.extractedTime &&
            parsed.extractedDate !== 'null' &&
            parsed.extractedTime !== 'null'
        ) {
            const rawDate = `${parsed.extractedDate} ${parsed.extractedTime}`;
            const parsedDate = dayjs.tz(rawDate, "YYYY-MM-DD HH:mm", "America/Sao_Paulo");
            if (parsedDate.isValid()) {
                finalIsoDate = parsedDate.format();
                log.info('AI', 'horário proposto/extraído', {
                    iso: finalIsoDate,
                    localBR: parsedDate.format('DD/MM/YYYY HH:mm'),
                    wantsSchedule,
                });
            }
        } else if (askingWho) {
            log.info('AI', 'cliente perguntou profissionais disponíveis — sem confirmar marca');
        }

        // isScheduling da IA = intenção de fechar; o WhatsApp só marca após "sim".
        const isScheduling = wantsSchedule && !!finalIsoDate && !askingWho;

        const responseText =
            typeof parsed.response === 'string' && parsed.response.trim()
                ? parsed.response.trim()
                : 'Como posso ajudar?';

        return {
            isScheduling,
            isCancelling: Boolean(parsed.isCancelling),
            date: finalIsoDate,
            extractedDate:
                typeof parsed.extractedDate === 'string' && parsed.extractedDate !== 'null'
                    ? parsed.extractedDate
                    : null,
            extractedTime:
                typeof parsed.extractedTime === 'string' && parsed.extractedTime !== 'null'
                    ? parsed.extractedTime
                    : null,
            response: responseText,
            barberSelection,
            barberConfirmed,
            canConfirmSchedule,
            askingProfessionalAvailability: askingWho,
        };

    } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        if (isLeakedApiKeyError(error)) {
            console.error('[WAGOO AI] Serviço indisponível até substituir GEMINI_API_KEY no Render.');
        } else {
            console.error('[WAGOO AI] Erro fatal:', detail, error);
        }
        return {
            isScheduling: false,
            isCancelling: false,
            response: isLeakedApiKeyError(error)
                ? 'Estou indisponível no momento. Tente de novo em alguns minutos.'
                : 'Desculpe, tive um problema. Pode repetir?',
            date: null,
            extractedDate: null,
            extractedTime: null,
            barberSelection: null,
            barberConfirmed: false,
            canConfirmSchedule: false,
            askingProfessionalAvailability: false,
        };
    }
};
