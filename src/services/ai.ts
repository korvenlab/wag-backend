import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const isMessageUseless = (message: string): boolean => {
    if (!message) return true;
    const lowerMsg = message.toLowerCase().trim();
    const isLaugh = /^(k|h|a|r|s)+$/.test(lowerMsg);
    const ignoreList = ['oi', 'oii', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'tudo bem', 'tudo bem?', 'ok', 'blz', '👍', 'sim', 'não', 'nao'];
    return isLaugh || ignoreList.includes(lowerMsg) || lowerMsg.length <= 2;
};

const truncateHistory = (history: string): string => {
    if (!history) return "";
    const messages = history.split('\n').filter(msg => msg.trim() !== '');
    return messages.slice(-7).join('\n');
};

export const analyzeMessage = async (
    history: string, 
    currentMessage: string, 
    isAiEnabled: boolean, 
    dbRow: { 
        start_time: string, 
        end_time: string, 
        active_days: any, 
        store_name: string 
    }
) => {
    
    if (!isAiEnabled) return { isScheduling: false, response: null };
    if (isMessageUseless(currentMessage)) return { isScheduling: false, response: null };

    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-3.1-flash-lite-preview" 
        });

        // ==========================================
        // LÓGICA DE FUSO HORÁRIO REFORÇADA (BRT - UTC-3)
        // ==========================================
        const date = new Date();
        // Forçamos o cálculo para garantir que, independente do servidor, o horário seja Brasília
        const brDate = new Date(date.toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        
        const hours = brDate.getHours().toString().padStart(2, '0');
        const minutes = brDate.getMinutes().toString().padStart(2, '0');
        const currentTimeBR = `${hours}:${minutes}`;
        const dataFormatadaBR = brDate.toLocaleDateString('pt-BR');

        const diasSemanaMap = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
        const diaAtualNome = diasSemanaMap[brDate.getDay()];

        // Tratamento do active_days
        let activeDaysArray: string[] = [];
        try {
            activeDaysArray = typeof dbRow.active_days === 'string' 
                ? JSON.parse(dbRow.active_days) 
                : dbRow.active_days;
        } catch (e) {
            activeDaysArray = [];
        }

        const isClosedToday = !activeDaysArray.includes(diaAtualNome);

        // Verificação lógica se o estabelecimento já fechou
        // Isso ajuda a IA a não cometer erros de comparação
        const [hourNow, minNow] = currentTimeBR.split(':').map(Number);
        const [hourEnd, minEnd] = dbRow.end_time.split(':').map(Number);
        const isPastClosing = (hourNow > hourEnd) || (hourNow === hourEnd && minNow >= minEnd);

        const statusFuncionamento = isClosedToday 
            ? `FECHADA (Hoje é ${diaAtualNome} e não atendemos).`
            : isPastClosing 
                ? `ENCERRADA (A loja fechou às ${dbRow.end_time} e agora são ${currentTimeBR}).`
                : `ABERTA (Atendimento até às ${dbRow.end_time}. Agora são exatamente ${currentTimeBR}).`;

        const generationConfig = {
            temperature: 0.1, 
            maxOutputTokens: 150, 
            responseMimeType: "application/json",
        };

        const prompt = `
        Aja como Lucy, secretária virtual da loja "${dbRow.store_name}".
        
        CONTEXTO TEMPORAL OBRIGATÓRIO:
        - Data de Hoje: ${dataFormatadaBR}
        - Dia da Semana: ${diaAtualNome}
        - Horário Oficial agora: ${currentTimeBR}
        - Status Atual: ${statusFuncionamento}

        REGRAS:
        1. Se o Status for ENCERRADA ou FECHADA, explique ao cliente que no momento não há atendimento, citando que agora são ${currentTimeBR}.
        2. Se o cliente pedir para agendar "hoje" ou "agora" e já passou das ${dbRow.end_time}, sugira o próximo dia disponível.
        3. Nunca use o horário do seu sistema interno, use APENAS o Horário Oficial informado acima: ${currentTimeBR}.

        Responda APENAS JSON:
        {
            "isScheduling": boolean,
            "date": "YYYY-MM-DDTHH:mm:ss" | null,
            "response": "Texto da resposta em nome da ${dbRow.store_name}"
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
            return { isScheduling: false, response: null };
        }

    } catch (error: any) {
        console.error("❌ Erro Gemini:", error.message);
        return { isScheduling: false, response: null };
    }
};
