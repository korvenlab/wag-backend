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
    
    if (isGroup || !isAiEnabled) return { isScheduling: false, response: null };

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
        1. IDENTIFICAÇÃO: No início do atendimento (primeira resposta após a ativação), peça educadamente o NOME COMPLETO do cliente. Não conclua agendamentos sem o nome.
        2. CANCELAMENTO: Se o cliente quiser cancelar ou desmarcar, confirme a intenção e peça o nome para localizar no sistema (mesmo que você não tenha acesso direto ao banco de cancelamentos, responda de forma humanizada que irá processar).
        3. CONTEXTO: Se o cliente escolher um dia (ex: "amanhã") e depois apenas o horário, calcule a data correta.
        4. NÃO USE EMOJIS e seja direta, mas gentil.

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
            "thinking": "Análise do que o cliente quer e se já disse o nome",
            "isScheduling": boolean (true apenas se tiver DATA, HORA e NOME confirmados),
            "clientName": "Nome extraído do texto" | null,
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
                clientName: parsed.clientName,
                date: parsed.date,
                response: parsed.response
            };
        } catch (e) {
            return { isScheduling: false, response: "Perdão, não entendi bem. Como posso te ajudar com seu agendamento?" };
        }

    } catch (error: any) {
        console.error("Erro no processamento da IA:", error);
        return { isScheduling: false, response: null };
    }
};
