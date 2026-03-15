import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

// Inicializa com a chave de API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// Filtro rápido para ignorar mensagens curtas demais ou confirmações básicas
const isMessageUseless = (message: string): boolean => {
    if (!message) return true;
    const lowerMsg = message.toLowerCase().trim();
    const isLaugh = /^(k|h|a|r|s)+$/.test(lowerMsg);
    
    const ignoreList = ['ok', 'blz', '👍', 'sim', 'não', 'nao'];
    
    return isLaugh || ignoreList.includes(lowerMsg) || lowerMsg.length <= 1;
};

export const analyzeMessage = async (history: string, currentMessage: string, isAiEnabled: boolean, operatingHours: { start: string, end: string }) => {
    
    if (!isAiEnabled) {
        console.log("⏸️ [AI] IA desativada pelo interruptor. Mensagem ignorada.");
        return { isScheduling: false, response: null };
    }

    // Intercepta saudações para responder imediatamente sem gastar processamento da IA
    const lowerMsg = currentMessage.toLowerCase().trim();
    const greetings = ['oi', 'oii', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'tudo bem', 'tudo bem?'];
    
    if (greetings.includes(lowerMsg)) {
        console.log("👋 [AI] Saudação detectada. Respondendo sem chamar a API do Gemini.");
        return { 
            isScheduling: false, 
            response: "Olá! Sou a assistente virtual da loja. Como posso ajudar com o seu agendamento hoje?" 
        };
    }

    if (isMessageUseless(currentMessage)) {
        console.log(`🛑 [AI] Mensagem ignorada pelo filtro rápido: "${currentMessage}"`);
        return { isScheduling: false, response: null };
    }

    try {
        console.log("🧠 [AI] Enviando contexto para a API do Google Gemini...");
        
        // CORREÇÃO: Utilizando o nome oficial do modelo suportado pela API v1
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
        
        MENSAGEM ATUAL DO CLIENTE:
        "${currentMessage}"

        SUA MISSÃO: Analisar o histórico acima e gerenciar o agendamento.
        Você deve ser RIGOROSA: Só agende se tiver certeza absoluta do DIA e da HORA.
        
        REGRAS DE DECISÃO:
        1. INTENÇÃO: O cliente quer agendar? Se a conversa for aleatória, retorne "response": null.
        
        2. VALIDAÇÃO DE HORÁRIO:
           - Se pedir um horário ANTES das ${operatingHours.start} ou DEPOIS das ${operatingHours.end}, NÃO AGENDE.
           - Retorne "isScheduling": false e em "response" informe o horário de funcionamento amigavelmente.

        3. VERIFICAÇÃO DE DADOS:
           - Dia e Hora válidos: Retorne "isScheduling": true e "date" em ISO (yyyy-MM-ddTHH:mm:ss). No "response", confirme que irá verificar a disponibilidade na agenda.
           - Falta o Dia: Retorne "isScheduling": false, "response": "Para qual dia seria esse horário?"
           - Falta a Hora: Retorne "isScheduling": false, "response": "Qual horário você prefere para esse dia?"
           - Intenção vaga ("Quero marcar"): Retorne "isScheduling": false, "response": "Para qual dia e horário você gostaria?"
           
        FORMATO DE RESPOSTA (JSON PURO, SEM MARKDOWN):
        {
            "isScheduling": boolean,
            "date": "2026-03-15T15:00:00" | null,
            "response": "Texto da pergunta ou null"
        }
        `;

        const result = await model.generateContent(prompt);
        let text = result.response.text();

        console.log("🤖 [AI] Resposta Bruta do Gemini recebida:\n", text);

        text = text.replace(/```json/g, '').replace(/```/g, '').trim();

        try {
            return JSON.parse(text);
        } catch (jsonError) {
            console.error("❌ [AI] Erro ao converter texto da IA para JSON. Texto recebido:", text);
            return { isScheduling: false, response: "Desculpe, não compreendi muito bem. Poderia repetir a data e hora desejada?" };
        }
    } catch (error: any) {
        console.error("❌ [AI] Erro fatal de conexão com a API do Gemini:", error);
        return { isScheduling: false, response: "No momento meu sistema está passando por uma instabilidade de conexão. Tente novamente em breve." };
    }
};
