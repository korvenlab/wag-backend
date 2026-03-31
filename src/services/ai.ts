import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview";

export const hasSchedulingIntent = (message: string): boolean => {
    if (!message) return false;
    const lowerMsg = message.toLowerCase().trim();
    const keywords = [
        'horário', 'horario', 'agendar', 'marcar', 'vaga', 'disponível', 
        'disponivel', 'amanhã', 'amanha', 'hoje', 'agenda', 'reservar', 
        'sessão', 'marcado', 'cancelar', 'desmarcar', 'mudar', 'trocar'
    ];
    return keywords.some(keyword => lowerMsg.includes(keyword)) || /\d/.test(lowerMsg);
};

export const analyzeMessage = async (
    history: string, 
    currentMessage: string, 
    isAiEnabled: boolean, 
    isGroup: boolean, 
    busySlots: string[], 
    dbRow: { 
        store_name: string,
        working_hours: any, 
        service_duration: number
    }
) => {
    
    if (isGroup || !isAiEnabled) return { isScheduling: false, isCancelling: false, response: null };

    try {
        const model = genAI.getGenerativeModel({ model: MODEL_NAME });

        const date = new Date();
        const brDate = new Date(date.toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        const currentTimeBR = brDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const dataFormatadaBR = brDate.toLocaleDateString('pt-BR');
        const diasSemanaMap = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
        const diaAtualNome = diasSemanaMap[brDate.getDay()];

        const generationConfig = {
            temperature: 0, 
            maxOutputTokens: 600, 
            responseMimeType: "application/json",
        };

        const prompt = `
        Você é a Lucy, assistente virtual da "${dbRow.store_name}".
        Sua missão é realizar agendamentos com precisão absoluta e proatividade.

        REGRAS DE DISPONIBILIDADE E CONFLITO (CRÍTICO):
        1. VERIFICAÇÃO DE BUSY SLOTS: Compare o horário que o cliente quer com a lista de "Slots ocupados". Se o horário estiver ocupado ou conflitar com a duração de ${dbRow.service_duration}min de um agendamento existente, você NÃO PODE confirmar.
        2. PROATIVIDADE EM CONFLITOS: Se o horário estiver ocupado ou fora dos "Horários da Loja", sua resposta DEVE obrigatoriamente:
           a) Informar educadamente que o horário solicitado já está preenchido ou indisponível.
           b) Analisar os horários da loja e os slots ocupados para sugerir o PRÓXIMO horário DISPONÍVEL mais próximo para o cliente.
        3. FUSO HORÁRIO: Use o horário de Brasília (${currentTimeBR}). Se o cliente pede 15:00, a data deve ser exatamente "YYYY-MM-DDT15:00:00". Nunca subtraia 3 horas.

        CONTEXTO DO SISTEMA:
        - Hoje é: ${diaAtualNome}, ${dataFormatadaBR} às ${currentTimeBR}.
        - Horários da Loja (Frontend): ${JSON.stringify(dbRow.working_hours)}
        - Slots ocupados (Google Calendar): ${busySlots.length > 0 ? busySlots.join(", ") : "Nenhum no momento"}.
        - Duração do Serviço: ${dbRow.service_duration} minutos.

        HISTÓRICO:
        ${history || "Início de conversa."}

        MENSAGEM DO CLIENTE:
        "${currentMessage}"

        Responda obrigatoriamente neste formato JSON:
        {
            "thinking": "1. Qual horário foi pedido? 2. Está nos ocupados? 3. Se sim, qual o próximo livre nos horários da loja? 4. Montar resposta negando e oferecendo a nova opção.",
            "isScheduling": boolean (true apenas se for confirmar um horário que ESTÁ livre e dentro do turno),
            "isCancelling": boolean,
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
            const parsed = JSON.parse(text);
            return {
                isScheduling: parsed.isScheduling,
                isCancelling: parsed.isCancelling || false,
                date: parsed.date,
                response: parsed.response
            };
        } catch (e) {
            return { isScheduling: false, isCancelling: false, response: "Desculpe, poderia me confirmar novamente o dia e horário?" };
        }

    } catch (error: any) {
        console.error("Erro no processamento da IA:", error);
        return { isScheduling: false, isCancelling: false, response: null };
    }
};
