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

// MUDANÇA: Adicionado o parâmetro operatingHours
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
        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

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
        
        2. VALIDAÇÃO DE HORÁRIO DE FUNCIONAMENTO (MUITO IMPORTANTE):
           - Se o cliente pedir um horário ANTES das ${operatingHours.start} ou DEPOIS das ${operatingHours.end}, NÃO AGENDE.
           - Retorne "isScheduling": false e em "response" informe amigavelmente qual é o horário de funcionamento e peça para ele escolher outro horário.

        3. VERIFICAÇÃO DE DADOS:
           CASO A: DADOS COMPLETOS E DENTRO DO HORÁRIO (Dia E Hora identificados válidos)
           - Retorne "isScheduling": true
           - Retorne "date": "Data em formato ISO (yyyy-MM-ddTHH:mm:ss)"

           CASO B: FALTA O DIA (Só tem a Hora)
           - NÃO ASSUMA QUE É HOJE.
           - Retorne "isScheduling": false, "response": "Para qual dia seria esse horário?"
           
           CASO C: FALTA A HORA (Só tem o Dia)
           - Retorne "isScheduling": false, "response": "Qual horário você prefere para esse dia?"
           
           CASO D: INTENÇÃO VAGA
           - Retorne "isScheduling": false, "response": "Para qual dia e horário você gostaria?"
           
        4. TOLERÂNCIA LINGUÍSTICA:
           - Aceite "hj", "amn". Ignore erros ortográficos.

        FORMATO DE RESPOSTA (JSON PURO, SEM MARKDOWN):
        {
            "isScheduling": boolean,
            "date": "2025-01-01T15:00:00" | null,
            "response": "Texto da pergunta ou null"
        }
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text();

        console.log("🤖 Gemini Analisou Contexto:", text);

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
