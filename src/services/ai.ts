import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// Define o Gemini 3.1 Flash Lite como padrão absoluto
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview";

const isMessageUseless = (message: string): boolean => {
    if (!message) return true;
    const lowerMsg = message.toLowerCase().trim();
    const isLaugh = /^(k|h|a|r|s)+$/.test(lowerMsg);
    const ignoreList = ['oi', 'oii', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'tudo bem', 'tudo bem?', 'ok', 'blz', '👍', 'sim', 'não', 'nao'];
    return isLaugh || ignoreList.includes(lowerMsg) || lowerMsg.length <= 2;
};

export const analyzeMessage = async (
    history: string, 
    currentMessage: string, 
    isAiEnabled: boolean, 
    busySlots: string[], 
    dbRow: { 
        store_name: string,
        working_hours: any, 
        service_duration: number
    }
) => {
    
    if (!isAiEnabled) return { isScheduling: false, response: null };
    if (isMessageUseless(currentMessage)) return { isScheduling: false, response: null };

    try {
        const model = genAI.getGenerativeModel({ 
            model: MODEL_NAME 
        });

        // ==========================================
        // DATA E HORA EM TEMPO REAL (BRASÍLIA)
        // ==========================================
        const date = new Date();
        const brDate = new Date(date.toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        
        const currentTimeBR = brDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const dataFormatadaBR = brDate.toLocaleDateString('pt-BR');
        const diasSemanaMap = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
        const diaAtualNome = diasSemanaMap[brDate.getDay()];

        const generationConfig = {
            temperature: 0.3, 
            maxOutputTokens: 400, 
            responseMimeType: "application/json",
        };

        const prompt = `
        Você é a Lucy, assistente pessoal da "${dbRow.store_name}".
        Sua comunicação deve ser extremamente humanizada, acolhedora e educada. 
        
        REGRAS CRÍTICAS DE ESTILO:
        - NÃO USE EMOJIS em hipótese alguma.
        - Não pareça um robô. Evite frases como "Horário confirmado" ou "Erro no sistema".
        - Escreva de forma fluida, como se você estivesse realmente digitando para um cliente.
        - Use um vocabulário maduro e profissional, mas próximo.

        CONTEXTO DE ATENDIMENTO:
        - Horário atual: ${diaAtualNome}, ${dataFormatadaBR} às ${currentTimeBR}.
        - Cronograma de funcionamento (JSON): ${JSON.stringify(dbRow.working_hours)}
        - Agendamentos já existentes (Ocupados): ${busySlots.length > 0 ? busySlots.join(", ") : "Nenhum no momento"}.
        - Duração de cada serviço: ${dbRow.service_duration} minutos.

        SUA MISSÃO AO INTERAGIR:
        1. Se o cliente pedir um horário indisponível hoje:
           - Explique a situação de forma gentil e sugira o mesmo horário para amanhã ou opções próximas.
        2. Se o cliente for vago, pergunte o horário preferido.
        3. Nunca diga apenas "não". Ofereça alternativas.

        HISTÓRICO:
        ${history}

        CLIENTE:
        ${currentMessage}

        Responda APENAS JSON:
        {
            "isScheduling": boolean,
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
            return JSON.parse(text);
        } catch (e) {
            return { isScheduling: false, response: "Perdão, não consegui processar isso agora. Pode repetir o horário desejado?" };
        }

    } catch (error: any) {
        console.error(`❌ Erro Gemini 3.1:`, error.message);
        return { isScheduling: false, response: "Estou passando por uma instabilidade técnica momentânea. Pode tentar novamente em instantes?" };
    }
};
