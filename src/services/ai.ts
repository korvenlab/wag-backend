// LOGICA DO CELEBRO DA IA COMO LER E ENVIAR MENSAGENS
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

export const analyzeMessage = async (history: string, currentMessage: string, isAiEnabled: boolean, operatingHours: { start: string, end: string }) => {
    if (!isAiEnabled) {
        return { isScheduling: false, response: null };
    }

    if (isMessageUseless(currentMessage)) {
        return { isScheduling: false, response: null };
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const prompt = `
        Aja como a secretária virtual "Lucy".
        Data/Hora atual do sistema: ${new Date().toLocaleString('pt-BR')}

        🏪 HORÁRIO DE FUNCIONAMENTO DO ESTABELECIMENTO:
        Aberto das ${operatingHours.start} até às ${operatingHours.end}.

        HISTÓRICO DA CONVERSA (Do mais antigo para o mais recente):
        ---
        ${history}
        ---

        SUA MISSÃO: Analisar o histórico acima e gerenciar o agendamento.
        Você deve ser RIGOROSA: Só agende se tiver certeza absoluta do DIA e da HORA.
        
        REGRAS DE DECISÃO:
        1. INTENÇÃO: O cliente quer agendar? Se a conversa for aleatória, retorne "response": null.
        
        2. VALIDAÇÃO DE HORÁRIO:
           - Se pedir um horário ANTES das ${operatingHours.start} ou DEPOIS das ${operatingHours.end}, NÃO AGENDE.
           - Retorne "isScheduling": false e em "response" informe o horário de funcionamento amigavelmente.

        3. VERIFICAÇÃO DE DADOS:
           - Dia e Hora válidos: Retorne "isScheduling": true e "date" em ISO (yyyy-MM-ddTHH:mm:ss).
           - Falta o Dia: Retorne "isScheduling": false, "response": "Para qual dia seria esse horário?"
           - Falta a Hora: Retorne "isScheduling": false, "response": "Qual horário você prefere para esse dia?"
           
        FORMATO DE RESPOSTA (JSON PURO, SEM MARKDOWN):
        {
            "isScheduling": boolean,
            "date": "2026-03-15T15:00:00" | null,
            "response": "Texto da pergunta ou null"
        }
        `;

        const result = await model.generateContent(prompt);
        let text = result.response.text();
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();

        try {
            return JSON.parse(text);
        } catch (jsonError) {
            console.error("❌ Erro ao ler JSON da IA:", text);
            return { isScheduling: false, response: null };
        }
    } catch (error: any) {
        console.error("❌ Erro Geral na IA:", error);
        return { isScheduling: false, response: null };
    }
};
