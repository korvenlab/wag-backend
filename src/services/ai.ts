import { GoogleGenerativeAI } from "@google-generative-ai/javascript";
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
        // CORREÇÃO: Usando o caminho completo 'models/gemini-1.5-flash' para evitar o erro 404
        // Este é o modelo mais barato e rápido disponível.
        const model = genAI.getGenerativeModel({ 
            model: "models/gemini-1.5-flash"
        });

        // Configuração de geração para economia e precisão
        const generationConfig = {
            temperature: 0.1, // Menor criatividade = mais precisão e menos tokens desperdiçados
            topP: 0.95,
            topK: 40,
            maxOutputTokens: 200, // Limita o gasto de tokens na resposta
            responseMimeType: "application/json", // Força JSON nativo (se a SDK suportar)
        };

        const prompt = `
        Aja como Lucy, secretária virtual.
        Data/Hora atual: ${new Date().toLocaleString('pt-BR')}
        Aberto: ${operatingHours.start} às ${operatingHours.end}.

        HISTÓRICO:
        ${history}

        REGRAS:
        1. Identifique intenção de agendamento.
        2. Se fora do horário (${operatingHours.start}-${operatingHours.end}), negue e informe horário.
        3. Se faltar Dia ou Hora, peça o dado faltante.
        4. Só confirme (isScheduling: true) se tiver Dia e Hora válidos.

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

        // Limpeza extra caso a IA ignore o comando de JSON puro
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();

        try {
            return JSON.parse(text);
        } catch (jsonError) {
            console.error("❌ Erro no parse do JSON:", text);
            return { isScheduling: false, response: "Desculpe, tive um erro interno. Pode repetir?" };
        }

    } catch (error: any) {
        console.error("❌ Erro Geral na IA:", error.message);
        return { isScheduling: false, response: null };
    }
};
