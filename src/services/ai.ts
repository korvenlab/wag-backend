import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("America/Sao_Paulo");

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview";

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
    const keywords = ['horário', 'horario', 'agendar', 'marcar', 'vaga', 'disponível', 'disponivel', 'amanhã', 'amanha', 'hoje', 'agenda', 'reservar', 'sessão', 'marcado', 'cancelar', 'desmarcar', 'mudar', 'trocar', 'barbeiro', 'profissional', 'corte'];
    return keywords.some(keyword => lowerMsg.includes(keyword)) || /\d/.test(lowerMsg);
};

export const analyzeMessage = async (
    history: string,
    currentMessage: string,
    isAiEnabled: boolean,
    isGroup: boolean,
    busySlots: string[],
    dbRow: {
        store_name: string,
        working_hours: unknown,
        service_duration: number
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

    try {
        const model = genAI.getGenerativeModel({ model: MODEL_NAME });
        const multiBarber = isMultiBarberTeam(activeBarbeiros);
        const singleBarberName =
            activeBarbeiros.length === 1 ? activeBarbeiros[0].nome : null;

        const agoraBR = dayjs().tz("America/Sao_Paulo");
        const currentTimeBR = agoraBR.format('HH:mm');
        const dataFormatadaBR = agoraBR.format('DD/MM/YYYY');
        const diaAtualNome = agoraBR.format('dddd');

        const teamBlock = multiBarber
            ? `
        CENÁRIO B — MÚLTIPLOS PROFISSIONAIS (${activeBarbeiros.length} activos):
        Equipe: ${activeBarbeiros.map((b) => b.nome).join(', ')}
        Opção extra: "Sem Preferência" (qualquer profissional com vaga).

        Estado da escolha:
        - Profissional confirmado: ${schedulingState.barberConfirmed ? 'SIM' : 'NÃO'}
        - Escolha actual: ${schedulingState.selectedBarberName ?? 'ainda não definido'}

        REGRAS OBRIGATÓRIAS:
        1. Ao detectar intenção de agendar, PERGUNTE com qual profissional o cliente quer marcar OU "Sem Preferência".
        2. Se o cliente não conhecer os profissionais, perguntar quem trabalha na barbearia, ou pedir indicação — LISTE os nomes de forma amigável.
        3. NUNCA apresente horários definitivos nem confirme marcação (isScheduling com data/hora) ANTES de barberConfirmed=true.
        4. Só depois da escolha, apresente horários livres (use OCUPADOS filtrados para o profissional escolhido).
        5. Se o cliente escolheu "Sem Preferência", sugira SEMPRE os horários mais cedo disponíveis (use SUGESTÕES_SEM_PREFERÊNCIA se existir no contexto).
        6. barberSelection = nome exacto da lista ou "SEM_PREFERENCIA". barberConfirmed=true só após escolha explícita.
        `
            : `
        CENÁRIO A — UM ÚNICO PROFISSIONAL${singleBarberName ? ` (${singleBarberName})` : ''}:
        - NÃO pergunte preferência de barbeiro, NÃO liste equipe, NÃO mencione "Sem Preferência".
        - Avance directamente para horários disponíveis e confirmação de data/hora.
        - barberConfirmed=true quando houver intenção de agendar.
        - barberSelection deve ser null.
        `;

        const busyContext = multiBarber && !schedulingState.barberConfirmed
            ? 'Aguardando escolha do profissional — não use horários ocupados para sugerir slots ainda.'
            : busySlots.join(', ') || 'nenhum';

        const generationConfig = {
            temperature: 0,
            maxOutputTokens: 700,
            responseMimeType: "application/json",
        };

        const prompt = `
        Você é o Wagoo, assistente da "${dbRow.store_name}".
        Extraia intenção de agendamento e escolha de profissional conforme o cenário.

        REGRAS DE EXTRAÇÃO:
        - Se o cliente quer marcar, extraia DATA (YYYY-MM-DD) e HORA (HH:mm) apenas quando puder confirmar (Cenário A ou B com profissional já escolhido).
        - Hoje é ${diaAtualNome}, ${dataFormatadaBR} às ${currentTimeBR}.
        - Duração do serviço: ${dbRow.service_duration} minutos.

        OCUPADOS (contexto de agenda): ${busyContext}
        HORÁRIOS DA LOJA: ${JSON.stringify(dbRow.working_hours)}
        ${teamBlock}

        HISTÓRICO:
        ${history}

        MENSAGEM:
        "${currentMessage}"

        Responda em JSON:
        {
            "isScheduling": boolean,
            "isCancelling": boolean,
            "extractedDate": "YYYY-MM-DD ou null",
            "extractedTime": "HH:mm ou null",
            "barberSelection": "nome exacto, SEM_PREFERENCIA ou null",
            "barberConfirmed": boolean,
            "response": "Resposta humanizada em português do Brasil"
        }`;

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig
        });

        const response = await result.response;
        const parsed = JSON.parse(response.text().replace(/```json/g, '').replace(/```/g, '').trim());

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
            parsed.extractedTime
        ) {
            const rawDate = `${parsed.extractedDate} ${parsed.extractedTime}`;
            finalIsoDate = dayjs.tz(rawDate, "YYYY-MM-DD HH:mm", "America/Sao_Paulo").format();
            console.log(`[WAGOO] Agendamento solicitado para: ${finalIsoDate}`);
        }

        const isScheduling = wantsSchedule && !!finalIsoDate;

        return {
            isScheduling,
            isCancelling: parsed.isCancelling || false,
            date: finalIsoDate,
            response: parsed.response,
            barberSelection,
            barberConfirmed,
            canConfirmSchedule,
        };

    } catch (error: unknown) {
        console.error("Erro Wagoo AI:", error);
        return {
            isScheduling: false,
            isCancelling: false,
            response: "Poderia repetir o horário?",
            date: null,
            barberSelection: null,
            barberConfirmed: false,
            canConfirmSchedule: false,
        };
    }
};
