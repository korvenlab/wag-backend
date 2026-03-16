import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview";

// Função para filtrar mensagens irrelevantes ou fora do escopo de agendamento
const shouldIgnoreMessage = (message: string): boolean => {
    if (!message) return true;
    const lowerMsg = message.toLowerCase().trim();
    
    // 1. Filtro de risadas
    const isLaugh = /^(k|h|a|r|s)+$/.test(lowerMsg);
    if (isLaugh) return true;

    // 2. Palavras-chave obrigatórias para agendamento
    // Se não tiver NADA disso, o bot não responde para não ser invasivo
    const schedulingKeywords = [
        'horário', 'horario', 'agendar', 'marcar', 'vaga', 'disponível', 
        'disponivel', 'amanhã', 'amanha', 'hoje', 'dia', 'calendário', 
        'serviço', 'consulta', 'agenda', 'reservar', 'sessão'
    ];

    const hasKeyword = schedulingKeywords.some(keyword => lowerMsg.includes(keyword));
    const hasNumbers = /\d/.test(lowerMsg); // Verifica se tem números (ex: "as 14h")

    // Ignora se não tiver palavras de agendamento E não tiver menção a horas/números
    if (!hasKeyword && !hasNumbers) return true;

    return false;
};

export const analyzeMessage = async (
    history: string, 
    currentMessage: string, 
    isAiEnabled: boolean, 
    isGroup: boolean, // NOVO: Parâmetro para identificar se é grupo
    busySlots: string[], 
    dbRow: { 
        store_name: string,
        working_hours: any, 
        service_duration: number
    }
) => {
    
    // REGRA DE OURO: Nunca interagir em grupos
    if (isGroup) {
        console.log("Refusing: Message is from a group.");
        return { isScheduling: false, response: null };
    }

    if (!isAiEnabled) return { isScheduling: false, response: null };

    // Só responde se o assunto for estritamente agendamento/horários
    if (shouldIgnoreMessage(currentMessage)) {
        console.log("Ignoring: Message out of scheduling scope.");
        return { isScheduling: false, response: null };
    }

    try {
        const model = genAI.getGenerativeModel({ 
            model: MODEL_NAME 
        });

        const date = new Date();
        const brDate = new Date(date.toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        
        const currentTimeBR = brDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const dataFormatadaBR = brDate.toLocaleDateString('pt-BR');
        const diasSemanaMap = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
        const diaAtualNome = diasSemanaMap[brDate.getDay()];

        const generationConfig = {
            temperature: 0.2, // Reduzido para ser mais preciso
            maxOutputTokens: 400, 
            responseMimeType: "application/json",
        };

        const prompt = `
        Você é a Lucy, assistente virtual da "${dbRow.store_name}".
        Sua única função é realizar agendamentos e informar horários.

        REGRAS DE SEGURANÇA:
        - Se o cliente falar de qualquer assunto que NÃO seja agendamento ou dúvida de horários, você deve educadamente dizer que só consegue ajudar com marcações.
        - NUNCA responda mensagens em grupos (esta regra é filtrada antes, mas mantenha o escopo individual).
        - NÃO USE EMOJIS.

        CONTEXTO:
        - Hoje é ${diaAtualNome}, ${dataFormatadaBR} e agora são ${currentTimeBR}.
        - Horários da loja: ${JSON.stringify(dbRow.working_hours)}
        - Ocupados: ${busySlots.join(", ")}
        - Duração: ${dbRow.service_duration} min.

        HISTÓRICO:
        ${history}

        CLIENTE:
        ${currentMessage}

        Responda APENAS JSON:
        {
            "isScheduling": boolean,
            "date": "YYYY-MM-DDTHH:mm:ss" | null,
            "response": "Sua resposta curta, humanizada e sem emojis"
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
            return { isScheduling: false, response: "Poderia me repetir o dia e horário que você deseja agendar?" };
        }

    } catch (error: any) {
        console.error(`❌ Erro Gemini:`, error.message);
        return { isScheduling: false, response: null };
    }
};
