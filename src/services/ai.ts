import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview";

/**
 * 🚪 PORTÃO DE ENTRADA (Economia de API)
 * Verifica se a mensagem inicial tem intenção de agendamento ou cancelamento.
 */
export const hasSchedulingIntent = (message: string): boolean => {
    if (!message) return false;
    const lowerMsg = message.toLowerCase().trim();
    const keywords = [
        'horário', 'horario', 'agendar', 'marcar', 'vaga', 'disponível', 
        'disponivel', 'amanhã', 'amanha', 'hoje', 'agenda', 'reservar', 
        'sessão', 'marcado', 'cancelar', 'desmarcar', 'mudar', 'trocar'
    ];
    const hasKeyword = keywords.some(keyword => lowerMsg.includes(keyword));
    const hasNumbers = /\d/.test(lowerMsg);
    return hasKeyword || hasNumbers;
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
    
    if (isGroup || !isAiEnabled) return { isScheduling: false, isCancelling: false, response: null };

    try {
        const model = genAI.getGenerativeModel({ model: MODEL_NAME });

        const date = new Date();
        const brDate = new Date(date.toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        const currentTimeBR = brDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const dataFormatadaBR = brDate.toLocaleDateString('pt-BR');
        const diasSemanaMap = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
        const diaAtualNome = diasSemanaMap[brDate.getDay()];

        const generationConfig = {
            temperature: 0, 
            maxOutputTokens: 500, 
            responseMimeType: "application/json",
        };

        const prompt = `
        Você é a Lucy, assistente virtual humanizada da "${dbRow.store_name}".
        Sua missão é realizar e gerenciar agendamentos baseando-se no histórico.

        REGRAS DE OURO:
        1. AGENDAMENTO: NÃO peça o nome do cliente em nenhuma hipótese. Foque apenas em confirmar a DATA e o HORÁRIO desejado.
        2. CANCELAMENTO: Se o cliente quiser cancelar ou desmarcar, identifique a intenção e retorne isCancelling como true imediatamente. NÃO peça nome ou documentos para isso.
        3. CONTEXTO: Use o histórico para calcular datas relativas (ex: se o cliente disse "amanhã" em uma mensagem e "às 10h" na outra).
        4. TOM DE VOZ: Seja direta, gentil e NÃO use emojis.

        CONTEXTO DO SISTEMA:
        - Hoje é: ${diaAtualNome}, ${dataFormatadaBR} às ${currentTimeBR}.
        - Horários da Loja: ${JSON.stringify(dbRow.working_hours)}
        - Slots ocupados: ${busySlots.length > 0 ? busySlots.join(", ") : "Nenhum"}.
        - Duração: ${dbRow.service_duration} minutos.

        HISTÓRICO RECENTE:
        ${history || "Início de conversa."}

        MENSAGEM ATUAL:
        "${currentMessage}"

        Responda obrigatoriamente neste formato JSON:
        {
            "thinking": "Análise rápida da intenção do cliente",
            "isScheduling": boolean (true apenas se tiver DATA e HORA confirmadas),
            "isCancelling": boolean (true se o cliente quiser cancelar/desmarcar),
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
            return {
                isScheduling: parsed.isScheduling,
                isCancelling: parsed.isCancelling || false,
                date: parsed.date,
                response: parsed.response
            };
        } catch (e) {
            return { isScheduling: false, isCancelling: false, response: "Para qual dia e horário você deseja marcar?" };
        }

    } catch (error: any) {
        console.error("Erro no processamento da IA:", error);
        return { isScheduling: false, isCancelling: false, response: null };
    }
};
