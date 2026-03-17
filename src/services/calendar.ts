// LOGICA DA INTEGRACAO COM O CALENDARIO DO GOOGLE (CORRIGIDA)
import { google } from 'googleapis';
import { addMinutes, parseISO, startOfDay, endOfDay } from 'date-fns';
import { supabase } from '../lib/supabase';

/**
 * Obtém o cliente OAuth usando o EMAIL como identificador (Chave mais confiável entre sistemas)
 */
const getOAuthClient = async (email: string) => {
    // 1. Mudança Crítica: Buscamos pelo campo 'email' em vez de 'id'
    const { data: profile, error } = await supabase
        .from('profiles')
        .select('googleAuth') 
        .eq('email', email.toLowerCase()) // Garante que ignore maiúsculas/minúsculas
        .single();

    if (error || !profile || !profile.googleAuth) {
        console.warn(`⚠️ [CALENDAR] Usuário ${email} não possui integração ou perfil não encontrado.`);
        return null;
    }

    const googleAuth = profile.googleAuth as any;

    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URL
    );

    oauth2Client.setCredentials({
        access_token: googleAuth.accessToken,
        refresh_token: googleAuth.refreshToken,
        expiry_date: googleAuth.expiryDate
    });

    // Listener para atualizar tokens automaticamente (Auto-refresh)
    oauth2Client.on('tokens', async (tokens) => {
        console.log(`🔄 [CALENDAR] Renovando tokens para ${email}...`);
        
        const updatedAuth = {
            ...googleAuth,
            accessToken: tokens.access_token || googleAuth.accessToken,
            expiryDate: tokens.expiry_date || googleAuth.expiryDate,
        };

        if (tokens.refresh_token) {
            updatedAuth.refreshToken = tokens.refresh_token;
        }

        // Atualizamos no banco usando o e-mail como referência
        await supabase
            .from('profiles')
            .update({ googleAuth: updatedAuth })
            .eq('email', email.toLowerCase());
            
        console.log(`✅ [CALENDAR] Tokens renovados com sucesso.`);
    });

    return google.calendar({ version: 'v3', auth: oauth2Client });
};

/**
 * BUSCA TODOS OS HORÁRIOS OCUPADOS
 */
export const getBusySlots = async (email: string, dateIso: string): Promise<string[]> => {
    try {
        const calendar = await getOAuthClient(email);
        if (!calendar) return [];

        const dayStart = startOfDay(parseISO(dateIso));
        const dayEnd = endOfDay(parseISO(dateIso));

        const response = await calendar.freebusy.query({
            requestBody: {
                timeMin: dayStart.toISOString(),
                timeMax: dayEnd.toISOString(),
                items: [{ id: 'primary' }]
            }
        });

        const busy = response.data.calendars?.['primary'].busy || [];
        return busy.map(slot => slot.start as string);
    } catch (error) {
        console.error(`❌ Erro ao buscar slots de ${email}:`, error);
        return [];
    }
};

/**
 * CHECA DISPONIBILIDADE
 */
export const checkAvailability = async (email: string, dateIso: string, durationMin: number = 30): Promise<boolean> => {
    try {
        const calendar = await getOAuthClient(email);
        if (!calendar) return true; 

        const start = parseISO(dateIso);
        const end = addMinutes(start, durationMin);

        const response = await calendar.freebusy.query({
            requestBody: {
                timeMin: start.toISOString(),
                timeMax: end.toISOString(),
                items: [{ id: 'primary' }]
            }
        });

        const busySlots = response.data.calendars?.['primary'].busy;
        return !busySlots || busySlots.length === 0;
    } catch (error) {
        console.error(`❌ Erro na agenda de ${email}:`, error);
        return true; 
    }
};

/**
 * CRIA O EVENTO
 */
export const createEvent = async (
    email: string, 
    clientName: string, 
    clientPhone: string, 
    dateIso: string,
    durationMin: number = 30 
): Promise<boolean> => {
    try {
        const calendar = await getOAuthClient(email);
        if (!calendar) return false;

        const start = parseISO(dateIso);
        const end = addMinutes(start, durationMin);

        await calendar.events.insert({
            calendarId: 'primary',
            requestBody: {
                summary: `Agendamento: ${clientName}`,
                description: `Telefone: ${clientPhone}\nAgendado via Lucy IA.`,
                start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
                end: { dateTime: end.toISOString(), timeZone: 'America/Sao_Paulo' },
            }
        });
        
        console.log(`✅ Evento criado com sucesso para ${email}`);
        return true;
    } catch (error) {
        console.error(`❌ Erro ao criar evento para ${email}:`, error);
        return false;
    }
};
