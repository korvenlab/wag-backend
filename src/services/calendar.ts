// LOGICA DA INTEGRACAO COM O CALENDARIO DO GOOGLE
import { google } from 'googleapis';
import { addMinutes, parseISO, startOfDay, endOfDay } from 'date-fns';
import { supabase } from '../lib/supabase';

/**
 * Obtém o cliente OAuth e atualiza o banco automaticamente se o token renovar
 */
const getOAuthClient = async (userId: string) => {
    // 1. Busca as credenciais na tabela 'profiles'
    const { data: profile, error } = await supabase
        .from('profiles')
        .select('googleAuth') 
        .eq('id', userId)
        .single();

    // Se não houver tokens, retornamos null para não quebrar o fluxo da Lucy
    if (error || !profile || !profile.googleAuth) {
        console.warn(`⚠️ [CALENDAR] Usuário ${userId} não possui integração configurada na tabela profiles.`);
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

    // Listener para salvar novos tokens automaticamente quando o Google renovar o acesso
    oauth2Client.on('tokens', async (tokens) => {
        console.log(`🔄 [CALENDAR] Renovando tokens para o perfil ${userId}...`);
        
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
            .eq('id', userId);
            
        console.log(`✅ [CALENDAR] Novos tokens persistidos no banco.`);
    });

    return google.calendar({ version: 'v3', auth: oauth2Client });
};

/**
 * BUSCA TODOS OS HORÁRIOS OCUPADOS DE UM DIA
 */
export const getBusySlots = async (userId: string, dateIso: string): Promise<string[]> => {
    try {
        const calendar = await getOAuthClient(userId);
        if (!calendar) return []; // Retorna lista vazia se não houver Google conectado

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
        console.error(`❌ Erro ao buscar slots ocupados de ${userId}:`, error);
        return [];
    }
};

export const checkAvailability = async (userId: string, dateIso: string, durationMin: number = 30): Promise<boolean> => {
    try {
        const calendar = await getOAuthClient(userId);
        if (!calendar) return true; // Se não tem agenda, assume disponível para não travar a Lucy

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
        console.error(`❌ Erro ao checar agenda de ${userId}:`, error);
        return true; 
    }
};

export const createEvent = async (
    userId: string, 
    clientName: string, 
    clientPhone: string, 
    dateIso: string,
    durationMin: number = 30 
): Promise<boolean> => {
    try {
        const calendar = await getOAuthClient(userId);
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
        
        console.log(`✅ Evento criado na agenda de ${userId}`);
        return true;
    } catch (error) {
        console.error(`❌ Erro ao criar evento para ${userId}:`, error);
        return false;
    }
};
