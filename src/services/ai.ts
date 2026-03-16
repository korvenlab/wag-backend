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
    dbRow: { 
        store_name: string,
        active_days: any,
        // Turnos e Status
        start_time: string, end_time: string, is_turno1_active: boolean,
        start_time_2: string, end_time_2: string, is_turno2_active: boolean,
        start_time_3: string, end_time_3: string, is_turno3_active: boolean
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

        // Parse dos dias de atendimento
        let activeDaysArray: string[] = [];
        try {
            activeDaysArray = typeof dbRow.active_days === 'string' ? JSON.parse(dbRow.active_days) : dbRow.active_days;
        } catch (e) { activeDaysArray = []; }

        // Construção da lista de turnos para a Lucy saber o que responder
        let infoTurnos = "";
        if (dbRow.is_turno1_active) infoTurnos += `- Turno 1: ${dbRow.start_time} às ${dbRow.end_time}\n`;
        if (dbRow.is_turno2_active) infoTurnos += `- Turno 2: ${dbRow.start_time_2} às ${dbRow.end_time_2}\n`;
        if (dbRow.is_turno3_active) infoTurnos += `- Turno 3: ${dbRow.start_time_3} às ${dbRow.end_time_3}\n`;

        const generationConfig = {
            temperature: 0.1, 
            maxOutputTokens: 250, 
            responseMimeType: "application/json",
        };

        const prompt = `
        Você é a Lucy, assistente da loja "${dbRow.store_name}".
        Seu objetivo é agendar clientes. Você conversa 24h por dia, mas o agendamento no sistema só é permitido nos horários da loja.

        REGRAS DE OURO:
        1. HORÁRIOS DA LOJA:
        ${infoTurnos}
        2. DIAS DE ATENDIMENTO: ${activeDaysArray.join(", ")}
        3. AGORA SÃO: ${currentTimeBR} de ${diaAtualNome}, ${dataFormatadaBR}.

        COMPORTAMENTO:
        - Se o cliente solicitar um horário que ESTÁ dentro de um turno ativo e no dia correto, defina "isScheduling": true.
        - Se o cliente solicitar um horário que NÃO está nos turnos (ex: no intervalo ou após o fechamento), defina "isScheduling": false e explique educadamente que esse horário não está disponível, informando quais são os nossos horários de atendimento.
        - Seja sempre prestativa. Se o cliente falar às 7h querendo marcar para as 18h e a loja fecha às 17h, explique isso a ele.

        HISTÓRICO:
        ${history}

        MENSAGEM DO CLIENTE:
        ${currentMessage}

        Responda APENAS JSON:
        {
            "isScheduling": boolean,
            "date": "YYYY-MM-DDTHH:mm:ss" | null,
            "response": "Sua resposta carismática"
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
            console.error("Erro no Parse JSON da Lucy");
            return { isScheduling: false, response: "Ops, tive um pequeno problema técnico. Pode me dizer novamente o horário que deseja?" };
        }

    } catch (error: any) {
        console.error("❌ Erro Gemini:", error.message);
        return { isScheduling: false, response: null };
    }
};
