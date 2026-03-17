import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview";

const shouldIgnoreMessage = (message: string): boolean => {
    if (!message) return true;
    const lowerMsg = message.toLowerCase().trim();
    const schedulingKeywords = ['horário', 'horario', 'agendar', 'marcar', 'vaga', 'disponível', 'disponivel', 'amanhã', 'amanha', 'hoje', 'dia', 'agenda', 'reservar', 'sessão', 'marcado'];
    const hasKeyword = schedulingKeywords.some(keyword => lowerMsg.includes(keyword));
    const hasNumbers = /\d/.test(lowerMsg);
    return !hasKeyword && !hasNumbers;
};

export const analyzeMessage = async (
    history: string, 
    currentMessage: string, 
    isAiEnabled: boolean, 
    isGroup: boolean, 
    busySlots: string[], 
    dbRow: { 
        store_name: string,
        working_hours: any, 
        service_duration: number
    }
) => {
    
    if (isGroup || !isAiEnabled) return { isScheduling: false, response: null };
    if (shouldIgnoreMessage(currentMessage)) return { isScheduling: false, response: null };

    try {
        const model = genAI.getGenerativeModel({ model: MODEL_NAME });

        const date = new Date();
        const brDate = new Date(date.toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        const currentTimeBR = brDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const dataFormatadaBR = brDate.toLocaleDateString('pt-BR');
        const diasSemanaMap = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
        const diaAtualNome = diasSemanaMap[brDate.getDay()];

        const generationConfig = {
            temperature: 0, // Precisão máxima para evitar erros de data
            maxOutputTokens: 500, 
            responseMimeType: "application/json",
        };

        const prompt = `
        Você é a Lucy, assistente virtual humanizada da "${dbRow.store_name}".
        Sua missão é realizar agendamentos baseando-se estritamente no histórico de conversa.

        REGRAS DE OURO DE CONTEXTO:
        1. Se o histórico mostra que o cliente escolheu uma data (ex: "sexta-feira") e na mensagem atual ele disse apenas um horário (ex: "as 10h"), você DEVE calcular a data final para essa sexta-feira específica.
        2. Nunca assuma que "9h" é hoje se houver uma data diferente pendente no histórico.
        3. Se o cliente mudar de ideia no histórico, a última data mencionada é a que vale.
        4. NÃO USE EMOJIS.

        CONTEXTO DO SISTEMA:
        - Hoje é: ${diaAtualNome}, ${dataFormatadaBR} às ${currentTimeBR}.
        - Horários da Loja: ${JSON.stringify(dbRow.working_hours)}
        - Slots já ocupados: ${busySlots.length > 0 ? busySlots.join(", ") : "Nenhum"}.
        - Duração: ${dbRow.service_duration} minutos.

        HISTÓRICO RECENTE:
        ${history || "Início de conversa."}

        MENSAGEM ATUAL:
        "${currentMessage}"

        Responda obrigatoriamente neste formato JSON:
        {
            "thinking": "Análise curta do histórico para definir a data correta",
            "isScheduling": boolean (true se você tem data e hora exatas para marcar),
            "date": "YYYY-MM-DDTHH:mm:ss" | null,
            "response": "Sua resposta humanizada para o cliente"
        }`;

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig
        });

        const response = await result.response;
        let text = response.text().replace(/```json/g, '').replace(/```/g, '').trim();

        try {
            const parsed = JSON.parse(text);
            // Retornamos apenas o que o sistema precisa, descartando o "thinking"
            return {
                isScheduling: parsed.isScheduling,
                date: parsed.date,
                response: parsed.response
            };
        } catch (e) {
            return { isScheduling: false, response: "Perdão, não entendi bem. Para qual dia e horário deseja marcar?" };
        }

    } catch (error: any) {
        console.error("Erro no processamento da IA:", error);
        return { isScheduling: false, response: null };
    }
};
