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
    const messages = history.split('\n').filter(msg => msg.trim() !== '');
    if (messages.length <= 7) return history;
    return messages.slice(-7).join('\n');
};

/**
 * FEATURE: A Lucy agora recebe as configurações dinâmicas do Banco de Dados.
 * @param operatingConfig - Objeto contendo o nome da loja e os horários vindos do banco.
 */
export const analyzeMessage = async (
    history: string, 
    currentMessage: string, 
    isAiEnabled: boolean, 
    operatingConfig: { 
        storeName: string, 
        start: string, 
        end: string,
        isClosedToday: boolean // Adicione esta flag vinda do seu banco (ex: se domingo está desmarcado)
    }
) => {
    
    if (!isAiEnabled) return { isScheduling: false, response: null };
    if (isMessageUseless(currentMessage)) return { isScheduling: false, response: null };

    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-3.1-flash-lite-preview" 
        });

        const limitedHistory = truncateHistory(history);
        const now = new Date();
        const diasSemana = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
        const diaAtualNome = diasSemana[now.getDay()];

        // FEATURE: Construção dinâmica do status de funcionamento
        const statusFuncionamento = operatingConfig.isClosedToday 
            ? `Hoje (${diaAtualNome}), a loja ${operatingConfig.storeName} está FECHADA para agendamentos.`
            : `Hoje (${diaAtualNome}), a loja ${operatingConfig.storeName} atende das ${operatingConfig.start} às ${operatingConfig.end}.`;

        const generationConfig = {
            temperature: 0.1, 
            maxOutputTokens: 150, 
            responseMimeType: "application/json",
        };

        const prompt = `
        Aja como Lucy, secretária virtual da "${operatingConfig.storeName}".
        
        SITUAÇÃO ATUAL DO ESTABELECIMENTO:
        - Agora são: ${now.toLocaleString('pt-BR')}
        - Status: ${statusFuncionamento}

        HISTÓRICO RECENTE:
        ${limitedHistory}

        SUA MISSÃO:
        1. Se o status for FECHADA, informe educadamente que hoje não abrimos e peça para escolher outro dia.
        2. Se estiver ABERTA, valide se o horário pedido está entre ${operatingConfig.start} e ${operatingConfig.end}.
        3. Se o cliente disser "hoje" ou "agora", considere a data: ${now.toISOString().split('T')[0]}.
        4. Agende (isScheduling: true) somente com DIA e HORA confirmados.

        Responda APENAS este JSON:
        {
            "isScheduling": boolean,
            "date": "YYYY-MM-DDTHH:mm:ss" | null,
            "response": "Texto amigável da Lucy em nome da ${operatingConfig.storeName}"
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
            console.error("❌ Erro JSON:", text);
            return { isScheduling: false, response: null };
        }

    } catch (error: any) {
        console.error("❌ Erro Gemini:", error.message);
        return { isScheduling: false, response: null };
    }
};
