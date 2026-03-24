// LOGICA DA INTEGRACAO COM O CALENDARIO DO GOOGLE (ATUALIZADA)
import { google } from 'googleapis';
import { addMinutes, parseISO, startOfDay, endOfDay } from 'date-fns';
import { supabase } from '../lib/supabase';

/**
 * Obtém o cliente OAuth usando o EMAIL como identificador
 */
const getOAuthClient = async (email: string) => {
    const { data: profile, error } = await supabase
        .from('profiles')
        .select('googleAuth') 
        .eq('email', email.toLowerCase())
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
 * BUSCA UM EVENTO FUTURO PELO TELEFONE DO CLIENTE
 * FEATURE: Permite cancelamento sem depender da memória RAM do bot.
 */
export const findEventByPhone = async (email: string, phone: string): Promise<any | null> => {
    try {
        const calendar = await getOAuthClient(email);
        if (!calendar) return null;

        const now = new Date().toISOString();
        const response = await calendar.events.list({
            calendarId: 'primary',
            timeMin: now, // Apenas eventos futuros
            q: phone,     // Busca o telefone na descrição do evento
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 1
        });

        const events = response.data.items || [];
        return events.length > 0 ? events[0] : null;
    } catch (error) {
        console.error(`❌ Erro ao buscar evento para o telefone ${phone}:`, error);
        return null;
    }
};

/**
 * DELETA UM EVENTO NO CALENDÁRIO
 */
export const deleteEvent = async (email: string, eventId: string): Promise<boolean> => {
    try {
        const calendar = await getOAuthClient(email);
        if (!calendar) return false;

        await calendar.events.delete({
            calendarId: 'primary',
            eventId: eventId
        });
        
        console.log(`🗑️ Evento ${eventId} deletado com sucesso para ${email}`);
        return true;
    } catch (error) {
        console.error(`❌ Erro ao deletar evento ${eventId}:`, error);
        return false;
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
