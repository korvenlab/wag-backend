import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview";

// Filtro de relevância permanece o mesmo
const shouldIgnoreMessage = (message: string): boolean => {
    if (!message) return true;
    const lowerMsg = message.toLowerCase().trim();
    const schedulingKeywords = ['horário', 'horario', 'agendar', 'marcar', 'vaga', 'disponível', 'disponivel', 'amanhã', 'amanha', 'hoje', 'dia', 'agenda', 'reservar'];
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
            temperature: 0.1, // Reduzi para 0.1 para evitar "alucinações" de data
            maxOutputTokens: 400, 
            responseMimeType: "application/json",
        };

        const prompt = `
        Você é a Lucy, assistente virtual da "${dbRow.store_name}".
        
        Sua tarefa é extrair intenções de agendamento baseadas em um diálogo.

        REGRAS DE MEMÓRIA E CONTEXTO (CRÍTICO):
        1. ANALISE O HISTÓRICO: Se no histórico o cliente mencionou uma data (ex: "sexta-feira") e agora ele enviou apenas o horário (ex: "9h"), o agendamento DEVE ser para a data mencionada anteriormente, e NÃO para hoje.
        2. PRIORIDADE: O contexto da conversa anterior dita a data, a menos que o cliente mude explicitamente (ex: "mudei de ideia, quero hoje").
        3. Se o cliente confirmou um horário sugerido por você na mensagem anterior, mantenha a data exata que você sugeriu.

        CONTEXTO TEMPORAL:
        - Hoje é: ${diaAtualNome}, ${dataFormatadaBR} (Horário: ${currentTimeBR})
        - Horários da loja: ${JSON.stringify(dbRow.working_hours)}
        - Ocupados: ${busySlots.join(", ")}

        HISTÓRICO DA CONVERSA:
        ${history}

        MENSAGEM ATUAL DO CLIENTE:
        "${currentMessage}"

        Responda estritamente em JSON:
        {
            "isScheduling": boolean (true apenas se tiver certeza da data e hora),
            "date": "YYYY-MM-DDTHH:mm:ss" (Calcule com base na data mencionada no histórico ou na mensagem atual),
            "response": "Sua resposta humanizada e sem emojis"
        }`;

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig
        });

        const response = await result.response;
        let text = response.text().replace(/```json/g, '').replace(/```/g, '').trim();

        try {
            return JSON.parse(text);
        } catch (e) {
            return { isScheduling: false, response: "Poderia me confirmar o dia e o horário, por gentileza?" };
        }

    } catch (error: any) {
        return { isScheduling: false, response: null };
    }
};
