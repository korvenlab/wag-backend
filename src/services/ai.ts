import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

// Configuração do DayJS para o Brasil
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("America/Sao_Paulo");

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite-preview";

export const hasSchedulingIntent = (message: string): boolean => {
    if (!message) return false;
    const lowerMsg = message.toLowerCase().trim();
    const keywords = ['horário', 'horario', 'agendar', 'marcar', 'vaga', 'disponível', 'disponivel', 'amanhã', 'amanha', 'hoje', 'agenda', 'reservar', 'sessão', 'marcado', 'cancelar', 'desmarcar', 'mudar', 'trocar'];
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

        // Data atual exata no Brasil usando DayJS
        const agoraBR = dayjs().tz("America/Sao_Paulo");
        const currentTimeBR = agoraBR.format('HH:mm');
        const dataFormatadaBR = agoraBR.format('DD/MM/YYYY');
        const diaAtualNome = agoraBR.format('dddd'); // Retorna o nome em português se configurado, ou use o map abaixo

        const generationConfig = {
            temperature: 0, 
            maxOutputTokens: 600, 
            responseMimeType: "application/json",
        };

        const prompt = `
        Você é a Lucy, assistente da "${dbRow.store_name}".
        Extraia a intenção de agendamento.

        REGRAS DE EXTRAÇÃO:
        - Se o cliente quer marcar, extraia a DATA (YYYY-MM-DD) e a HORA (HH:mm).
        - NÃO tente converter fusos. Apenas relate o que o cliente pediu.
        - Hoje é ${diaAtualNome}, ${dataFormatadaBR} às ${currentTimeBR}.

        OCUPADOS: ${busySlots.join(", ")}
        HORÁRIOS DA LOJA: ${JSON.stringify(dbRow.working_hours)}

        HISTÓRICO:
        ${history}

        MENSAGEM:
        "${currentMessage}"

        Responda em JSON:
        {
            "isScheduling": boolean,
            "isCancelling": boolean,
            "extractedDate": "YYYY-MM-DD",
            "extractedTime": "HH:mm",
            "response": "Sua resposta humanizada"
        }`;

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig
        });

        const response = await result.response;
        const parsed = JSON.parse(response.text().replace(/```json/g, '').replace(/```/g, '').trim());

        let finalIsoDate = null;

        if (parsed.isScheduling && parsed.extractedDate && parsed.extractedTime) {
            // 🛠️ O PULO DO GATO: Montamos a data usando DayJS travado em SP
            // Isso evita que o sistema subtraia 3 horas.
            const rawDate = `${parsed.extractedDate} ${parsed.extractedTime}`;
            finalIsoDate = dayjs.tz(rawDate, "YYYY-MM-DD HH:mm", "America/Sao_Paulo").format();
            
            console.log(`[LUCY] Agendamento solicitado para: ${finalIsoDate}`);
        }

        return {
            isScheduling: parsed.isScheduling,
            isCancelling: parsed.isCancelling || false,
            date: finalIsoDate, // Agora vai com o offset correto (ex: -03:00)
            response: parsed.response
        };

    } catch (error: any) {
        console.error("Erro Lucy AI:", error);
        return { isScheduling: false, isCancelling: false, response: "Poderia repetir o horário?" };
    }
};
