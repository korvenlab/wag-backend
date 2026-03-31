import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview";

export const hasSchedulingIntent = (message: string): boolean => {
    if (!message) return false;
    const lowerMsg = message.toLowerCase().trim();
    const keywords = [
        'horário', 'horario', 'agendar', 'marcar', 'vaga', 'disponível', 
        'disponivel', 'amanhã', 'amanha', 'hoje', 'agenda', 'reservar', 
        'sessão', 'marcado', 'cancelar', 'desmarcar', 'mudar', 'trocar'
    ];
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
        working_hours: any, 
        service_duration: number
    }
) => {
    
    if (isGroup || !isAiEnabled) return { isScheduling: false, isCancelling: false, response: null };

    try {
        const model = genAI.getGenerativeModel({ model: MODEL_NAME });

        const date = new Date();
        // Garantindo que o servidor pegue a data exata de SP
        const brDate = new Date(date.toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        const currentTimeBR = brDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const dataFormatadaBR = brDate.toLocaleDateString('pt-BR');
        const diasSemanaMap = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
        const diaAtualNome = diasSemanaMap[brDate.getDay()];

        const generationConfig = {
            temperature: 0, 
            maxOutputTokens: 600, 
            responseMimeType: "application/json",
        };

        const prompt = `
        Você é a Lucy, assistente virtual da "${dbRow.store_name}".
        Sua missão é realizar agendamentos com precisão absoluta.

        REGRAS CRÍTICAS DE FUSO HORÁRIO E DATA (GMT-3):
        1. NÃO CONVERTA PARA UTC: O sistema já opera no horário de Brasília. Se o cliente pedir "10:00", o valor no JSON deve ser exatamente "T10:00:00". 
        2. PROIBIDO SUBTRAIR HORAS: Se você retornar "07:00:00" para um pedido de "10:00", o agendamento sairá errado. Mantenha o valor literal pedido pelo cliente.
        3. FORMATO: "YYYY-MM-DDTHH:mm:ss". Exemplo: Se hoje é dia 15 e ele pede às 14h, use "2026-03-15T14:00:00".

        DISPONIBILIDADE:
        - Slots ocupados: ${busySlots.join(", ") || "Nenhum"}.
        - Horários da Loja: ${JSON.stringify(dbRow.working_hours)}
        - Se o horário pedido estiver ocupado, NÃO confirme. Informe que está cheio e sugira o próximo horário livre dentro dos turnos da loja.

        CONTEXTO ATUAL:
        - Hoje é: ${diaAtualNome}, ${dataFormatadaBR} às ${currentTimeBR}.
        - Duração: ${dbRow.service_duration} minutos.

        HISTÓRICO:
        ${history || "Início de conversa."}

        MENSAGEM DO CLIENTE:
        "${currentMessage}"

        Responda obrigatoriamente neste formato JSON:
        {
            "thinking": "Análise da data e hora literal sem conversão de fuso.",
            "isScheduling": boolean,
            "isCancelling": boolean,
            "date": "YYYY-MM-DDTHH:mm:ss" | null,
            "response": "Sua resposta humanizada e sem emojis"
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
            return { isScheduling: false, isCancelling: false, response: "Desculpe, poderia me confirmar novamente o dia e horário?" };
        }

    } catch (error: any) {
        console.error("Erro no processamento da IA:", error);
        return { isScheduling: false, isCancelling: false, response: null };
    }
};
