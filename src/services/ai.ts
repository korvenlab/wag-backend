import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

// Inicializa com a chave de API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// Filtro rápido para ignorar mensagens inúteis e economizar tokens
const isMessageUseless = (message: string): boolean => {
    if (!message) return true;
    const lowerMsg = message.toLowerCase().trim();
    const isLaugh = /^(k|h|a|r|s)+$/.test(lowerMsg);
    const ignoreList = ['oi', 'oii', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'tudo bem', 'tudo bem?', 'ok', 'blz', '👍', 'sim', 'não', 'nao'];
    return isLaugh || ignoreList.includes(lowerMsg) || lowerMsg.length <= 2;
};

export const analyzeMessage = async (history: string, currentMessage: string, isAiEnabled: boolean, operatingHours: { start: string, end: string }) => {
    
    if (!isAiEnabled) {
        console.log("⏸️ IA desativada pelo interruptor.");
        return { isScheduling: false, response: null };
    }

    if (isMessageUseless(currentMessage)) {
        console.log("🛑 Mensagem retida pelo filtro rápido:", currentMessage);
        return { isScheduling: false, response: null };
    }

    try {
        // CORREÇÃO: O modelo 1.5-flash é a versão mais barata e rápida.
        // Usamos apenas o nome simples "gemini-1.5-flash" que é o padrão da SDK oficial.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-3.1-flash-lite-preview"
        });

        // Configurações para economia extrema de tokens e precisão
        const generationConfig = {
            temperature: 0.1, 
            maxOutputTokens: 150, // Reduzi ainda mais para garantir o menor custo
            responseMimeType: "application/json",
        };

        const prompt = `
        Aja como Lucy, secretária virtual.
        Data atual: ${new Date().toLocaleString('pt-BR')}
        Horário: ${operatingHours.start} às ${operatingHours.end}.

        HISTÓRICO:
        ${history}

        REGRAS:
        1. Identifique intenção de agendamento.
        2. Se fora do horário (${operatingHours.start}-${operatingHours.end}), peça outro horário.
        3. Se faltar Dia ou Hora, pergunte.
        4. Só isScheduling: true se tiver Dia e Hora confirmados.

        Responda APENAS este JSON:
        {
            "isScheduling": boolean,
            "date": "YYYY-MM-DDTHH:mm:ss" | null,
            "response": string | null
        }`;

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig
        });

        const response = await result.response;
        let text = response.text();

        console.log("🤖 Resposta Lucy:", text);

        // Limpeza de segurança caso a IA envie markdown
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();

        try {
            return JSON.parse(text);
        } catch (jsonError) {
            console.error("❌ Erro no parse do JSON:", text);
            return { isScheduling: false, response: null };
        }

    } catch (error: any) {
        console.error("❌ Erro Geral na IA:", error.message);
        return { isScheduling: false, response: null };
    }
};
