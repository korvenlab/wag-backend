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
    if (!history) return "";
    const messages = history.split('\n').filter(msg => msg.trim() !== '');
    return messages.slice(-7).join('\n');
};

export const analyzeMessage = async (
    history: string, 
    currentMessage: string, 
    isAiEnabled: boolean, 
    dbRow: { 
        start_time: string, 
        end_time: string, 
        active_days: any, 
        store_name: string 
    }
) => {
    
    if (!isAiEnabled) return { isScheduling: false, response: null };
    if (isMessageUseless(currentMessage)) return { isScheduling: false, response: null };

    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-3.1-flash-lite-preview" 
        });

        // ==========================================
        // CORREÇÃO DE FUSO HORÁRIO (Brasília)
        // ==========================================
        const now = new Date();
        // Converte o horário do servidor para o horário de Brasília
        const brTime = new Intl.DateTimeFormat('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        }).format(now);

        const diasSemanaMap = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
        const diaAtualNome = diasSemanaMap[now.getDay()];

        // Tratamento do active_days
        let activeDaysArray: string[] = [];
        try {
            activeDaysArray = typeof dbRow.active_days === 'string' 
                ? JSON.parse(dbRow.active_days) 
                : dbRow.active_days;
        } catch (e) {
            activeDaysArray = [];
        }

        const isClosedToday = !activeDaysArray.includes(diaAtualNome);

        // EXTRAÇÃO DA HORA ATUAL PARA LÓGICA DE BLOQUEIO
        // Pegamos apenas a parte "HH:mm" da string formatada de Brasília
        const currentTimeBR = brTime.split(', ')[1].substring(0, 5); 

        const statusFuncionamento = isClosedToday 
            ? `FECHADA (Hoje é ${diaAtualNome} e não atendemos).`
            : `ABERTA (Hoje é ${diaAtualNome}. Atendimento das ${dbRow.start_time} às ${dbRow.end_time}. Agora são exatamente ${currentTimeBR}).`;

        const generationConfig = {
            temperature: 0.1, 
            maxOutputTokens: 150, 
            responseMimeType: "application/json",
        };

        const prompt = `
        Aja como Lucy, secretária virtual da loja "${dbRow.store_name}".
        
        CONTEXTO DE AGORA (Sempre use este horário):
        - Data e Hora em Brasília: ${brTime}
        - Dia da Semana: ${diaAtualNome}
        - Status: ${statusFuncionamento}

        HISTÓRICO RECENTE:
        ${truncateHistory(history)}

        MISSÃO:
        1. Se o cliente pedir um horário, compare com ${currentTimeBR}. Se o horário solicitado já passou ou a loja fechou às ${dbRow.end_time}, informe que encerramos.
        2. IMPORTANTE: Só diga que encerrou se a hora atual (${currentTimeBR}) for maior que ${dbRow.end_time}.
        3. Se estiver dentro do horário, prossiga com o agendamento.

        Responda APENAS JSON:
        {
            "isScheduling": boolean,
            "date": "YYYY-MM-DDTHH:mm:ss" | null,
            "response": "Texto amigável em nome da ${dbRow.store_name}"
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
            return { isScheduling: false, response: null };
        }

    } catch (error: any) {
        console.error("❌ Erro Gemini:", error.message);
        return { isScheduling: false, response: null };
    }
};
