// LOGICA DA INTEGRACAO COM O CALENDARIO DO GOOGLE

import { google } from 'googleapis';
import { addHours, parseISO } from 'date-fns';
import { supabase } from '../lib/supabase';

const getOAuthClient = async (clientId: string) => {
    // Busca as credenciais do Google no Supabase
    const { data: client, error } = await supabase
        .from('clients')
        .select('"googleAuth"') // Aspas duplas porque o nome da coluna tem CamelCase
        .eq('id', clientId)
        .single();

    if (error || !client || !client.googleAuth) {
        throw new Error("Usuário não possui credenciais do Google.");
    }

    const googleAuth = client.googleAuth as any;

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

    return google.calendar({ version: 'v3', auth: oauth2Client });
};

export const checkAvailability = async (clientId: string, dateIso: string): Promise<boolean> => {
    try {
        const calendar = await getOAuthClient(clientId);
        const start = parseISO(dateIso);
        const end = addHours(start, 1);

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
        console.error(`Erro ao checar agenda de ${clientId}:`, error);
        return false;
    }
};

export const createEvent = async (clientId: string, clientName: string, clientPhone: string, dateIso: string): Promise<boolean> => {
    try {
        const calendar = await getOAuthClient(clientId);
        const start = parseISO(dateIso);
        const end = addHours(start, 1);

        await calendar.events.insert({
            calendarId: 'primary',
            requestBody: {
                summary: `Agendamento: ${clientName}`,
                description: `Telefone: ${clientPhone}\nAgendado via Calendar Plus IA.`,
                start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
                end: { dateTime: end.toISOString(), timeZone: 'America/Sao_Paulo' },
            }
        });
        
        console.log(`✅ Evento criado na agenda de ${clientId}`);
        return true;
    } catch (error) {
        console.error(`Erro ao criar evento para ${clientId}:`, error);
        return false;
    }
};
