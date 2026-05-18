// Integração Google Calendar — agenda centralizada no usuário master
import { google } from 'googleapis';
import { addMinutes, parseISO, startOfDay, endOfDay } from 'date-fns';
import { supabase } from '../lib/supabase';

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

    const googleAuth = profile.googleAuth as Record<string, unknown>;

    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URL
    );

    oauth2Client.setCredentials({
        access_token: googleAuth.accessToken as string,
        refresh_token: googleAuth.refreshToken as string,
        expiry_date: googleAuth.expiryDate as number,
    });

    oauth2Client.on('tokens', async (tokens) => {
        const updatedAuth: Record<string, unknown> = {
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
    });

    return google.calendar({ version: 'v3', auth: oauth2Client });
};

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

export const findEventByPhone = async (email: string, phone: string): Promise<{ id: string; start: { dateTime: string } } | null> => {
    try {
        const calendar = await getOAuthClient(email);
        if (!calendar) return null;

        const now = new Date().toISOString();
        const response = await calendar.events.list({
            calendarId: 'primary',
            timeMin: now,
            q: phone,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 1
        });

        const events = response.data.items || [];
        if (!events.length || !events[0].id) return null;
        const ev = events[0];
        return {
            id: ev.id!,
            start: { dateTime: ev.start?.dateTime || ev.start?.date || '' },
        };
    } catch (error) {
        console.error(`❌ Erro ao buscar evento para o telefone ${phone}:`, error);
        return null;
    }
};

export const deleteEvent = async (email: string, eventId: string): Promise<boolean> => {
    try {
        const calendar = await getOAuthClient(email);
        if (!calendar) return false;

        await calendar.events.delete({
            calendarId: 'primary',
            eventId: eventId
        });

        return true;
    } catch (error) {
        console.error(`❌ Erro ao deletar evento ${eventId}:`, error);
        return false;
    }
};

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

export type CreateEventOptions = {
    barberName?: string;
    barberEmail?: string | null;
};

export const createEvent = async (
    email: string,
    clientName: string,
    clientPhone: string,
    dateIso: string,
    durationMin: number = 30,
    options: CreateEventOptions = {},
): Promise<boolean> => {
    try {
        const calendar = await getOAuthClient(email);
        if (!calendar) return false;

        const start = parseISO(dateIso);
        const end = addMinutes(start, durationMin);

        const barberLabel = options.barberName?.trim() || 'Sem Preferência';
        const summary = `[Wagoo] ${clientName} - Barbeiro: ${barberLabel}`;

        const requestBody: {
            summary: string;
            description: string;
            start: { dateTime: string; timeZone: string };
            end: { dateTime: string; timeZone: string };
            attendees?: { email: string }[];
        } = {
            summary,
            description: `Telefone: ${clientPhone}\nAgendado via Wagoo IA.`,
            start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
            end: { dateTime: end.toISOString(), timeZone: 'America/Sao_Paulo' },
        };

        if (options.barberEmail) {
            requestBody.attendees = [{ email: options.barberEmail }];
        }

        await calendar.events.insert({
            calendarId: 'primary',
            sendUpdates: options.barberEmail ? 'all' : 'none',
            requestBody,
        });

        console.log(`✅ Evento criado: ${summary}`);
        return true;
    } catch (error) {
        console.error(`❌ Erro ao criar evento para ${email}:`, error);
        return false;
    }
};
