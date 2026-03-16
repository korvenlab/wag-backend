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
    busySlots: string[], // Ex: ["2026-03-16T10:00:00", "2026-03-16T14:30:00"]
    dbRow: { 
        store_name: string,
        active_days: any,
        service_duration: number,
        start_time: string, end_time: string, is_turno1_active: boolean,
        start_time_2: string, end_time_2: string, is_turno2_active: boolean,
        start_time_3: string, end_time_3: string, is_turno3_active: boolean
    }
) => {
    
    if (!isAiEnabled) return { isScheduling: false, response: null };
    if (isMessageUseless(currentMessage)) return { isScheduling: false, response: null };

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const date = new Date();
        const brDate = new Date(date.toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        const currentTimeBR = brDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const dataFormatadaBR = brDate.toLocaleDateString('pt-BR');
        const diasSemanaMap = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];

        let activeDaysArray: string[] = [];
        try {
            activeDaysArray = typeof dbRow.active_days === 'string' ? JSON.parse(dbRow.active_days) : dbRow.active_days;
        } catch (e) { activeDaysArray = []; }

        // Montagem da agenda de funcionamento
        let agendaConfig = `DURAÇÃO DO SERVIÇO: ${dbRow.service_duration} minutos. `;
        if (dbRow.is_turno1_active) agendaConfig += `Turno 1: ${dbRow.start_time} às ${dbRow.end_time}. `;
        if (dbRow.is_turno2_active) agendaConfig += `Turno 2: ${dbRow.start_time_2} às ${dbRow.end_time_2}. `;
        if (dbRow.is_turno3_active) agendaConfig += `Turno 3: ${dbRow.start_time_3} às ${dbRow.end_time_3}. `;

        const generationConfig = {
            temperature: 0.1, 
            maxOutputTokens: 300, 
            responseMimeType: "application/json",
        };

        const prompt = `
        Você é a Lucy, assistente da "${dbRow.store_name}".
        
        SISTEMA DE AGENDAMENTO:
        - Horários de Funcionamento: ${agendaConfig}
        - Dias que atendemos: ${activeDaysArray.join(", ")}
        - Ocupação Atual (Google Agenda): ${busySlots.length > 0 ? busySlots.join(", ") : "Nenhum horário ocupado ainda."}
        - Contexto: Hoje é ${diasSemanaMap[brDate.getDay()]}, ${dataFormatadaBR} às ${currentTimeBR}.

        SUAS TAREFAS:
        1. Se o cliente pedir um horário FORA do funcionamento: Sugira o mesmo horário para o dia seguinte (se a loja atender e estiver vago). Informe os horários livres desse próximo dia.
        2. Se o cliente pedir um horário OCUPADO: Informe que já está preenchido. Liste TODOS os horários livres do dia solicitado dentro dos turnos ativos.
        3. Se não houver nada livre no dia: Sugira o dia seguinte informando as opções de horários.
        4. Agendamento Confirmado: Só defina "isScheduling": true se o horário estiver LIVRE e DENTRO dos turnos ligados.

        HISTÓRICO:
        ${history}

        CLIENTE:
        ${currentMessage}

        Responda APENAS JSON:
        {
            "isScheduling": boolean,
            "date": "YYYY-MM-DDTHH:mm:ss" | null,
            "response": "Resposta humanizada com as sugestões de horários livres"
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
            return { isScheduling: false, response: "Pode me confirmar o horário novamente?" };
        }

    } catch (error: any) {
        console.error("❌ Erro Lucy:", error.message);
        return { isScheduling: false, response: null };
    }
};
