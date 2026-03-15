import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

// Inicializa com a chave de API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// Filtro rápido para ignorar mensagens inúteis
const isMessageUseless = (message: string): boolean => {
    if (!message) return true;
    const lowerMsg = message.toLowerCase().trim();
    const isLaugh = /^(k|h|a|r|s)+$/.test(lowerMsg);
    const ignoreList = ['oi', 'oii', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'tudo bem', 'tudo bem?', 'ok', 'blz', '👍', 'sim', 'não', 'nao'];
    return isLaugh || ignoreList.includes(lowerMsg) || lowerMsg.length <= 2;
};

export const analyzeMessage = async (history: string, currentMessage: string, isAiEnabled: boolean, operatingHours: { start: string, end: string }) => {
    
    // Se a IA estiver desligada pelo interruptor geral, para aqui.
    if (!isAiEnabled) {
        console.log("⏸️ IA desativada pelo interruptor. Mensagem ignorada.");
        return { isScheduling: false, response: null };
    }

    if (isMessageUseless(currentMessage)) {
        console.log("🛑 Mensagem retida na porta pelo filtro rápido:", currentMessage);
        return { isScheduling: false, response: null };
    }

    try {
        // ALTERAÇÃO: Nome do modelo corrigido para evitar o erro 404 e usar a versão mais barata
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            // FEATURE: Força a resposta a ser sempre um JSON, economizando tokens de texto explicativo
            generationConfig: {
                responseMimeType: "application/json",
            }
        });

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

        1. INTENÇÃO:
           - O cliente quer agendar? (Ex: "quero marcar", "tem vaga?", "14h").
           - Se a conversa for aleatória, retorne "response": null.
        
        2. VALIDAÇÃO DE HORÁRIO DE FUNCIONAMENTO:
           - Se o cliente pedir um horário ANTES das ${operatingHours.start} ou DEPOIS das ${operatingHours.end}, NÃO AGENDE.
           - Retorne "isScheduling": false e em "response" informe o horário de funcionamento e peça outro horário.

        3. VERIFICAÇÃO DE DADOS:
           CASO A: DADOS COMPLETOS (Dia E Hora válidos) -> "isScheduling": true, "date": "ISO String"
           CASO B: FALTA O DIA (Só Hora) -> "isScheduling": false, "response": "Para qual dia seria esse horário?"
           CASO C: FALTA A HORA (Só Dia) -> "isScheduling": false, "response": "Qual horário você prefere?"
           CASO D: INTENÇÃO VAGA -> "isScheduling": false, "response": "Para qual dia e horário você gostaria?"
           
        4. TOLERÂNCIA LINGUÍSTICA: Aceite "hj", "amn" e ignore erros.

        Responda obrigatoriamente neste formato JSON:
        {
            "isScheduling": boolean,
            "date": string | null,
            "response": string | null
        }`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        console.log("🤖 Gemini Analisou Contexto:", text);

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
