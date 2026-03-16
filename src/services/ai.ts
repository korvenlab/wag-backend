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
            model: "gemini-1.5-flash" 
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
            temperature: 0.3, // Aumentado levemente para maior naturalidade no texto
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
        1. Se o cliente pedir um horário indisponível hoje (seja por estar fora do turno ou por já estar ocupado):
           - Explique a situação de forma gentil.
           - Sugira o mesmo horário para o dia seguinte, caso o cronograma permita.
           - Se não for possível amanhã, ofereça as opções livres mais próximas de forma textual.
        2. Se o cliente for vago, pergunte qual horário ficaria melhor para ele dentro das opções que você tem.
        3. Nunca diga apenas "não". Sempre apresente uma alternativa que ajude o cliente a agendar.

        REGRAS PARA O JSON:
        - isScheduling: true (apenas se houver um horário claro e disponível).
        - date: ISO string da data escolhida.
        - response: Sua resposta humanizada sem emojis.

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
            return { isScheduling: false, response: "Peço desculpas, mas não consegui processar sua mensagem agora. Você poderia me dizer novamente o horário que deseja?" };
        }

    } catch (error: any) {
        console.error("❌ Erro Gemini:", error.message);
        return { isScheduling: false, response: "No momento estou com uma instabilidade técnica. Poderia tentar novamente em alguns minutos, por gentileza?" };
    }
};
