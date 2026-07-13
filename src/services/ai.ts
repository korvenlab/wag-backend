import { GoogleGenerativeAI, type GenerateContentResult } from "@google/generative-ai";
import dotenv from 'dotenv';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { resolveNicheVocabulary } from '../lib/businessNiche';

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

export const hasSchedulingIntent = (message: string): boolean => {
    if (!message) return false;
    const lowerMsg = message.toLowerCase().trim();
    const keywords = [
      'horário', 'horario', 'agendar', 'marcar', 'vaga', 'disponível', 'disponivel',
      'amanhã', 'amanha', 'hoje', 'agenda', 'reservar', 'sessão', 'marcado', 'cancelar',
      'desmarcar', 'mudar', 'trocar', 'barbeiro', 'profissional', 'corte', 'cabelo',
      'manicure', 'unha', 'unhas', 'escova', 'barba', 'estética', 'estetica',
    ];
    return keywords.some(keyword => lowerMsg.includes(keyword)) || /\d/.test(lowerMsg);
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
            barberSelection: null as string | null,
            barberConfirmed: false,
            canConfirmSchedule: false,
        };
    }

    if (!GEMINI_API_KEY) {
        console.error('[WAGOO AI] GEMINI_API_KEY ausente — configure no Render');
        return {
            isScheduling: false,
            isCancelling: false,
            response: 'No momento não consigo processar mensagens. A equipa foi avisada.',
            date: null,
            barberSelection: null,
            barberConfirmed: false,
            canConfirmSchedule: false,
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
        `
            : `
        CENÁRIO A — UM PROFISSIONAL${singleBarberName ? ` (${singleBarberName})` : ''}:
        - Não pergunte ${professional} nem liste equipe.
        - Vá directo a dia/horário disponível.
        - barberConfirmed=true com intenção de agendar; barberSelection=null.
        `;

        const busyContext = multiBarber && !schedulingState.barberConfirmed
            ? `Aguardando escolha do ${professional}.`
            : busySlots.join(', ') || 'nenhum';

        const prompt = `
        Você é o Wagoo, secretária virtual da "${storeLabel}" (${businessType}) no WhatsApp.
        Extraia intenção de agendamento e escolha de ${professional}.

        NICHO DO NEGÓCIO (obrigatório respeitar):
        - Tipo: ${businessType} (${niche.label})
        - Singular: "${professional}" | Plural: "${professionals}"
        - Nunca diga "barbeiro", "barbeiros" ou "barbearia" salvo se o nicho for barbearia.
        - Nunca invente outro tipo de negócio.

        ESTILO DO CAMPO "response" (obrigatório):
        - Cordial e profissional, como secretária educada — nunca seca ou robótica.
        - Mínimo de caracteres: directo ao ponto, sem rodeios nem repetições.
        - Ideal: 1–2 frases curtas (≤160 caracteres; máximo ~220).
        - Cordialidade enxuta: "Olá", "Por favor", "Obrigada" quando couber — sem bajulação.
        - Proibido: elogios longos ("excelente profissional", "ótima escolha"), parágrafos, repetir o pedido do cliente.
        - Horários: formato compacto (ex: "14h, 15h30 ou 17h").
        - Uma pergunta por vez. Se isScheduling=true, NÃO escreva confirmação final — o sistema confirma depois.
        - Exemplos de tom: "Olá! Com o Marcos. Qual dia e horário?" | "Temos Marcos e Robson. Algum preferido?" | "Amanhã: 14h, 15h ou 16h30. Qual prefere?"

        EXTRAÇÃO:
        - DATA (YYYY-MM-DD) e HORA (HH:mm) só quando puder confirmar (Cenário A ou B com ${professional} escolhido).
        - Hoje: ${diaAtualNome}, ${dataFormatadaBR} ${currentTimeBR}.
        - Serviço: ${dbRow.service_duration ?? 30} min.

        OCUPADOS: ${busyContext}
        HORÁRIOS LOJA: ${JSON.stringify(dbRow.working_hours ?? {})}
        ${teamBlock}

        HISTÓRICO:
        ${history}

        MENSAGEM:
        "${currentMessage}"

        JSON válido apenas (sem markdown):
        {
            "isScheduling": boolean,
            "isCancelling": boolean,
            "extractedDate": "YYYY-MM-DD ou null",
            "extractedTime": "HH:mm ou null",
            "barberSelection": "nome exacto, SEM_PREFERENCIA ou null",
            "barberConfirmed": boolean,
            "response": "Resposta curta, cordial, em português do Brasil"
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

        if (
            wantsSchedule &&
            canConfirmSchedule &&
            parsed.extractedDate &&
            parsed.extractedTime &&
            parsed.extractedDate !== 'null' &&
            parsed.extractedTime !== 'null'
        ) {
            const rawDate = `${parsed.extractedDate} ${parsed.extractedTime}`;
            const parsedDate = dayjs.tz(rawDate, "YYYY-MM-DD HH:mm", "America/Sao_Paulo");
            if (parsedDate.isValid()) {
                finalIsoDate = parsedDate.format();
                console.log(`[WAGOO] Agendamento solicitado para: ${finalIsoDate}`);
            }
        }

        const isScheduling = wantsSchedule && !!finalIsoDate;

        const responseText =
            typeof parsed.response === 'string' && parsed.response.trim()
                ? parsed.response.trim()
                : 'Como posso ajudar?';

        return {
            isScheduling,
            isCancelling: Boolean(parsed.isCancelling),
            date: finalIsoDate,
            response: responseText,
            barberSelection,
            barberConfirmed,
            canConfirmSchedule,
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
            barberSelection: null,
            barberConfirmed: false,
            canConfirmSchedule: false,
        };
    }
};
