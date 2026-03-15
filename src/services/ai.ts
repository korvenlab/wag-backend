import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

// Inicializa a IA com a chave de API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

/**
 * Filtro para evitar gastos desnecessários com mensagens curtas ou risadas.
 */
const isMessageUseless = (message: string): boolean => {
    if (!message) return true;
    const lowerMsg = message.toLowerCase().trim();
    const isLaugh = /^(k|h|a|r|s)+$/.test(lowerMsg);
    const ignoreList = ['oi', 'oii', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'tudo bem', 'tudo bem?', 'ok', 'blz', '👍', 'sim', 'não', 'nao'];
    return isLaugh || ignoreList.includes(lowerMsg) || lowerMsg.length <= 2;
};

/**
 * Mantém apenas as últimas 7 mensagens para controle de custo (Tokens de entrada).
 */
const truncateHistory = (history: string): string => {
    if (!history) return "";
    const messages = history.split('\n').filter(msg => msg.trim() !== '');
    if (messages.length <= 7) return history;
    return messages.slice(-7).join('\n');
};

/**
 * Função Principal de Análise da Lucy
 */
export const analyzeMessage = async (
    history: string, 
    currentMessage: string, 
    isAiEnabled: boolean, 
    dbRow: { 
        start_time: string, 
        end_time: string, 
        active_days: any, // Pode vir como string ou array do Supabase
        store_name: string 
    }
) => {
    
    if (!isAiEnabled) return { isScheduling: false, response: null };
    if (isMessageUseless(currentMessage)) return { isScheduling: false, response: null };

    try {
        // Modelo 3.1 Flash Lite: Mais rápido e barato para 2026
        const model = genAI.getGenerativeModel({ 
            model: "gemini-3.1-flash-lite-preview" 
        });

        const now = new Date();
        const diasSemanaMap = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
        const diaAtualNome = diasSemanaMap[now.getDay()];

        // Tratamento do active_days (converte string do banco em array se necessário)
        let activeDaysArray: string[] = [];
        try {
            activeDaysArray = typeof dbRow.active_days === 'string' 
                ? JSON.parse(dbRow.active_days) 
                : dbRow.active_days;
        } catch (e) {
            activeDaysArray = [];
        }

        // Verifica se a loja abre HOJE de acordo com o banco
        const isClosedToday = !activeDaysArray.includes(diaAtualNome);

        // Define o status que será enviado no prompt para a IA não alucinar
        const statusFuncionamento = isClosedToday 
            ? `FECHADA. Hoje (${diaAtualNome}) não atendemos. Dias ativos são: ${activeDaysArray.join(', ')}.`
            : `ABERTA. Atendimento hoje das ${dbRow.start_time} às ${dbRow.end_time}.`;

        const generationConfig = {
            temperature: 0.1, // Baixa temperatura para evitar respostas criativas demais
            maxOutputTokens: 150, 
            responseMimeType: "application/json",
        };

        const prompt = `
        Aja como Lucy, secretária virtual da loja "${dbRow.store_name}".
        
        CONTEXTO DE AGORA:
        - Data e Hora: ${now.toLocaleString('pt-BR')}
        - Dia da Semana: ${diaAtualNome}
        - Status da Loja: ${statusFuncionamento}

        HISTÓRICO RECENTE:
        ${truncateHistory(history)}

        MISSÃO:
        1. Responda em nome da "${dbRow.store_name}".
        2. Se o Status for FECHADA, diga educadamente que hoje não abrimos.
        3. Se estiver ABERTA, valide se o horário pedido está entre ${dbRow.start_time} e ${dbRow.end_time}.
        4. Use a data ${now.toISOString().split('T')[0]} se o cliente disser "hoje" ou "agora".
        5. isScheduling só é true se você tiver certeza do DIA e HORA.

        Responda APENAS este JSON:
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
        } catch (jsonError) {
            console.error("❌ Erro ao converter JSON da Lucy:", text);
            return { isScheduling: false, response: "Desculpe, tive um erro técnico. Pode repetir?" };
        }

    } catch (error: any) {
        console.error("❌ Erro na API do Gemini:", error.message);
        return { isScheduling: false, response: null };
    }
};
