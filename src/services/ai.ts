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

        const agoraBR = dayjs().tz("America/Sao_Paulo");
        const currentTimeBR = agoraBR.format('HH:mm');
        const dataFormatadaBR = agoraBR.format('DD/MM/YYYY');
        const diaAtualNome = agoraBR.format('dddd');

        const teamBlock =
            activeBarbeiros.length > 0
                ? `
        EQUIPE ATIVA (obrigatório escolher antes de confirmar horário):
        ${activeBarbeiros.map((b) => `- ${b.nome}`).join('\n        ')}
        Opção extra: "Sem Preferência" (qualquer profissional disponível).

        Estado atual da escolha do cliente:
        - Profissional já confirmado: ${schedulingState.barberConfirmed ? 'SIM' : 'NÃO'}
        - Nome escolhido: ${schedulingState.selectedBarberName ?? 'ainda não definido'}

        REGRAS DE BARBEIRO:
        - Na primeira oportunidade de agendamento, apresente os nomes da equipe de forma amigável.
        - Pergunte explicitamente com qual profissional o cliente quer agendar OU se prefere "Sem Preferência".
        - NUNCA confirme um horário definitivo (isScheduling=true com data/hora) sem o cliente ter escolhido um profissional da lista ou "Sem Preferência".
        - Se o cliente mencionar um nome da equipe, preencha barberSelection com o nome exato ou "SEM_PREFERENCIA".
        - barberConfirmed=true somente quando o cliente escolheu um profissional ou Sem Preferência.
        `
                : `
        Não há equipe cadastrada — fluxo de um único profissional. barberConfirmed pode ser true quando houver intenção de agendar.
        `;

        const generationConfig = {
            temperature: 0,
            maxOutputTokens: 700,
            responseMimeType: "application/json",
        };

        const prompt = `
        Você é o Wagoo, assistente da "${dbRow.store_name}".
        Extraia a intenção de agendamento e a escolha de profissional quando aplicável.

        REGRAS DE EXTRAÇÃO:
        - Se o cliente quer marcar, extraia a DATA (YYYY-MM-DD) e a HORA (HH:mm) apenas quando já tiver profissional confirmado (ou sem equipe).
        - NÃO tente converter fusos. Apenas relate o que o cliente pediu.
        - Hoje é ${diaAtualNome}, ${dataFormatadaBR} às ${currentTimeBR}.

        OCUPADOS: ${busySlots.join(", ") || "nenhum"}
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
            "barberSelection": "nome exato do profissional, SEM_PREFERENCIA ou null",
            "barberConfirmed": boolean,
            "response": "Sua resposta humanizada em português"
        }`;

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig
        });

        const response = await result.response;
        const parsed = JSON.parse(response.text().replace(/```json/g, '').replace(/```/g, '').trim());

        const hasTeam = activeBarbeiros.length > 0;
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

        if (!hasTeam) {
            barberConfirmed = true;
            barberSelection = null;
        }

        const canConfirmSchedule =
            !hasTeam || barberConfirmed;

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
