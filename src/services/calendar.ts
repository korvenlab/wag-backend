// Integração Google Calendar — agenda centralizada no usuário master
import { google } from 'googleapis';
import { addMinutes, parseISO, startOfDay, endOfDay } from 'date-fns';
import { supabase } from '../lib/supabase';
import { formatTimeBR } from '../lib/dateTimeBR';
import {
  BR_TZ,
  dayWindowsFromWorkingHours,
  formatAvailabilityByPeriod,
  startOfDayBR,
} from '../lib/dateTimeBR';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { log } from '../lib/logger';

dayjs.extend(utc);
dayjs.extend(timezone);

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
    /** Nomes dos serviços (Agenda Web / multi-serviço). */
    serviceNames?: string | null;
    /** Origem do evento — muda só a descrição. */
    source?: 'ai' | 'agenda_web';
};

export type CreateEventResult = {
  id: string;
  startIso: string;
};

export const createEvent = async (
    email: string,
    clientName: string,
    clientPhone: string,
    dateIso: string,
    durationMin: number = 30,
    options: CreateEventOptions = {},
): Promise<CreateEventResult | null> => {
    try {
        const calendar = await getOAuthClient(email);
        if (!calendar) return null;

        const start = parseISO(dateIso);
        const end = addMinutes(start, durationMin);

        const barberLabel = options.barberName?.trim() || 'Sem Preferência';
        const summary = `[Wagoo] ${clientName} - Barbeiro: ${barberLabel}`;
        const via =
          options.source === 'agenda_web'
            ? 'Agendado via Agenda Web Wagoo.'
            : 'Agendado via Wagoo IA.';
        const servicesLine = options.serviceNames?.trim()
          ? `\nServiços: ${options.serviceNames.trim()}`
          : '';

        const requestBody: {
            summary: string;
            description: string;
            start: { dateTime: string; timeZone: string };
            end: { dateTime: string; timeZone: string };
            attendees?: { email: string }[];
        } = {
            summary,
            description: `Telefone: ${clientPhone}${servicesLine}\n${via}`,
            start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
            end: { dateTime: end.toISOString(), timeZone: 'America/Sao_Paulo' },
        };

        if (options.barberEmail) {
            requestBody.attendees = [{ email: options.barberEmail }];
        }

        const inserted = await calendar.events.insert({
            calendarId: 'primary',
            sendUpdates: options.barberEmail ? 'all' : 'none',
            requestBody,
        });

        const eventId = inserted.data.id;
        if (!eventId) {
            console.error(`❌ Evento criado sem id para ${email}`);
            return null;
        }

        console.log(`✅ Evento criado: ${summary} (${eventId})`);
        return { id: eventId, startIso: start.toISOString() };
    } catch (error) {
        console.error(`❌ Erro ao criar evento para ${email}:`, error);
        return null;
    }
};

/** Intervalos ocupados no Google Calendar (primary) para um dia YYYY-MM-DD (TZ BR). */
export const listGoogleBusyRangesForDay = async (
  email: string,
  dayYmd: string,
): Promise<Array<{ startIso: string; endIso: string }>> => {
  try {
    const calendar = await getOAuthClient(email);
    if (!calendar) return [];

    const timeMin = dayjs.tz(`${dayYmd}T00:00:00`, BR_TZ).toISOString();
    const timeMax = dayjs.tz(`${dayYmd}T00:00:00`, BR_TZ).add(1, 'day').toISOString();

    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        items: [{ id: 'primary' }],
      },
    });

    const busy = response.data.calendars?.primary?.busy ?? [];
    return busy
      .filter((b): b is { start: string; end: string } => Boolean(b.start && b.end))
      .map((b) => ({ startIso: b.start, endIso: b.end }));
  } catch (error) {
    console.error(`❌ Erro freebusy ${email} ${dayYmd}:`, error);
    return [];
  }
};

export type CalendarEventDto = {
    id: string;
    summary: string;
    description: string | null;
    start: string;
    end: string;
    htmlLink: string | null;
    source: 'wagoo' | 'other';
    clientName: string | null;
    clientPhone: string | null;
    barberName: string | null;
};

const WAGOO_SUMMARY_RE = /^\[Wagoo\]\s*(.+?)\s*-\s*Barbeiro:\s*(.+)$/i;
const PHONE_RE = /Telefone:\s*([+\d\s()-]+)/i;

function mapGoogleEvent(ev: {
    id?: string | null;
    summary?: string | null;
    description?: string | null;
    htmlLink?: string | null;
    start?: { dateTime?: string | null; date?: string | null };
    end?: { dateTime?: string | null; date?: string | null };
}): CalendarEventDto | null {
    const id = ev.id;
    const startRaw = ev.start?.dateTime || ev.start?.date;
    const endRaw = ev.end?.dateTime || ev.end?.date;
    if (!id || !startRaw || !endRaw) return null;

    const summary = ev.summary?.trim() || 'Sem título';
    const description = ev.description?.trim() || null;
    const wagooMatch = summary.match(WAGOO_SUMMARY_RE);
    const phoneMatch = description?.match(PHONE_RE);

    return {
        id,
        summary,
        description,
        start: startRaw,
        end: endRaw,
        htmlLink: ev.htmlLink ?? null,
        source: wagooMatch ? 'wagoo' : 'other',
        clientName: wagooMatch?.[1]?.trim() ?? null,
        clientPhone: phoneMatch?.[1]?.trim() ?? null,
        barberName: wagooMatch?.[2]?.trim() ?? null,
    };
}

/** Lista eventos do Google Calendar (primary) num intervalo ISO. */
export const listCalendarEvents = async (
    email: string,
    timeMin: string,
    timeMax: string,
): Promise<CalendarEventDto[]> => {
    try {
        const calendar = await getOAuthClient(email);
        if (!calendar) return [];

        const response = await calendar.events.list({
            calendarId: 'primary',
            timeMin,
            timeMax,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 250,
        });

        const items = response.data.items || [];
        return items
            .map((ev) => mapGoogleEvent(ev))
            .filter((ev): ev is CalendarEventDto => ev !== null);
    } catch (error) {
        console.error(`❌ Erro ao listar eventos de ${email}:`, error);
        return [];
    }
};

function eventWindow(ev: CalendarEventDto): { start: Date; end: Date } {
    return { start: parseISO(ev.start), end: parseISO(ev.end) };
}

function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
    return aStart < bEnd && bStart < aEnd;
}

/** Evento bloqueia o barbeiro indicado (agenda master com tags Wagoo). */
export function eventBlocksBarber(ev: CalendarEventDto, barberName: string): boolean {
    if (ev.source !== 'wagoo' || !ev.barberName) {
        return true;
    }
    const tag = ev.barberName.toLowerCase();
    if (tag.includes('sem prefer')) {
        return true;
    }
    return tag === barberName.trim().toLowerCase();
}

export type SchedulingAvailabilityOptions = {
    multiBarber: boolean;
    barberName?: string | null;
    semPreferencia?: boolean;
    activeBarberNames?: string[];
};

/** Horários ocupados para contexto da IA (filtrados por profissional quando aplicável). */
export async function getSchedulingBusyContext(
    email: string,
    dateIso: string,
    options: SchedulingAvailabilityOptions,
): Promise<string[]> {
    const dayStart = startOfDay(parseISO(dateIso));
    const dayEnd = endOfDay(parseISO(dateIso));
    const events = await listCalendarEvents(email, dayStart.toISOString(), dayEnd.toISOString());

    if (!options.multiBarber) {
        return events.map((e) => {
            return formatTimeBR(e.start);
        });
    }

    if (options.semPreferencia) {
        return events.map((e) => {
            const who = e.barberName || 'geral';
            return `${formatTimeBR(e.start)} (${who})`;
        });
    }

    if (options.barberName) {
        return events
            .filter((e) => eventBlocksBarber(e, options.barberName!))
            .map((e) => formatTimeBR(e.start));
    }

    return events.map((e) => formatTimeBR(e.start));
}

/** Valida se o horário está livre conforme o modo (1 barbeiro / multi / sem preferência). */
export async function checkSchedulingAvailability(
    email: string,
    dateIso: string,
    durationMin: number,
    options: SchedulingAvailabilityOptions,
): Promise<boolean> {
    try {
        const slotStart = parseISO(dateIso);
        const slotEnd = addMinutes(slotStart, durationMin);
        const events = await listCalendarEvents(
            email,
            startOfDay(slotStart).toISOString(),
            endOfDay(slotStart).toISOString(),
        );

        const conflicts = (ev: CalendarEventDto) => {
            const { start, end } = eventWindow(ev);
            return rangesOverlap(slotStart, slotEnd, start, end);
        };

        if (!options.multiBarber) {
            return !events.some((ev) => conflicts(ev));
        }

        const names = options.activeBarberNames ?? [];
        if (options.semPreferencia && names.length > 0) {
            return names.some(
                (name) => !events.some((ev) => conflicts(ev) && eventBlocksBarber(ev, name)),
            );
        }

        if (options.barberName) {
            return !events.some(
                (ev) => conflicts(ev) && eventBlocksBarber(ev, options.barberName!),
            );
        }

        return checkAvailability(email, dateIso, durationMin);
    } catch (error) {
        console.error(`❌ Erro checkSchedulingAvailability:`, error);
        return true;
    }
}

export type BarberSlotRef = { nome: string; google_calendar_email: string };

export type SemPreferenciaAssignment = {
    barberName: string;
    barberEmail: string | null;
};

export function isBarberFreeAtSlot(
    events: CalendarEventDto[],
    slotStart: Date,
    slotEnd: Date,
    barberName: string,
): boolean {
    return !events.some((ev) => {
        const { start, end } = eventWindow(ev);
        return (
            rangesOverlap(slotStart, slotEnd, start, end) && eventBlocksBarber(ev, barberName)
        );
    });
}

/**
 * Sem Preferência no horário pedido: primeiro profissional livre na ordem da equipe
 * (lista por nome ascendente = prioridade estável).
 */
export function pickBarberForSemPreferenciaSlot(
    events: CalendarEventDto[],
    slotStart: Date,
    durationMin: number,
    barbers: BarberSlotRef[],
): SemPreferenciaAssignment | null {
    const slotEnd = addMinutes(slotStart, durationMin);
    const ordered = [...barbers].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

    for (const b of ordered) {
        if (isBarberFreeAtSlot(events, slotStart, slotEnd, b.nome)) {
            return { barberName: b.nome, barberEmail: b.google_calendar_email };
        }
    }
    return null;
}

export async function resolveSemPreferenciaBooking(
    email: string,
    dateIso: string,
    durationMin: number,
    barbers: BarberSlotRef[],
): Promise<SemPreferenciaAssignment | null> {
    if (!barbers.length) return null;
    const slotStart = parseISO(dateIso);
    const events = await listCalendarEvents(
        email,
        startOfDay(slotStart).toISOString(),
        endOfDay(slotStart).toISOString(),
    );
    return pickBarberForSemPreferenciaSlot(events, slotStart, durationMin, barbers);
}

/** Profissionais livres no horário pedido (para responder "quem está disponível?"). */
export async function listFreeBarbersAtSlot(
    email: string,
    dateIso: string,
    durationMin: number,
    barbers: BarberSlotRef[],
): Promise<string[]> {
    if (!barbers.length) return [];
    const slotStart = parseISO(dateIso);
    const slotEnd = addMinutes(slotStart, durationMin);
    const events = await listCalendarEvents(
        email,
        startOfDay(slotStart).toISOString(),
        endOfDay(slotStart).toISOString(),
    );
    return barbers
        .filter((b) => isBarberFreeAtSlot(events, slotStart, slotEnd, b.nome))
        .map((b) => b.nome);
}

/**
 * Resume horários livres do dia por período (Manhã / Tarde / Noite),
 * fácil de ler no WhatsApp.
 */
export async function buildFreeRangesSummary(
    email: string,
    dayIso: string,
    durationMin: number,
    workingHours: unknown,
    options: SchedulingAvailabilityOptions & { barbers?: BarberSlotRef[] },
): Promise<string> {
    const step = Math.max(5, Number(durationMin) || 30);
    const windows = dayWindowsFromWorkingHours(workingHours, dayIso);
    const day = startOfDayBR(dayIso);
    const now = dayjs().tz(BR_TZ);
    const events = await listCalendarEvents(
        email,
        day.toISOString(),
        day.endOf('day').toISOString(),
    );

    const freeStarts: dayjs.Dayjs[] = [];
    const scanWindows =
        windows.length > 0
            ? windows
            : [{ startHm: '08:00', endHm: '20:00' }];

    log.info('CAL', 'buildFreeRangesSummary', {
        email,
        dayIso,
        dayBR: day.format('YYYY-MM-DD dddd'),
        windows: scanWindows.length,
        events: events.length,
        step,
        multiBarber: !!options.multiBarber,
    });

    for (const w of scanWindows) {
        const [sh, sm] = w.startHm.split(':').map(Number);
        const [eh, em] = w.endHm.split(':').map(Number);
        let cursor = day.hour(sh).minute(sm).second(0).millisecond(0);
        const end = day.hour(eh).minute(em).second(0).millisecond(0);

        while (!cursor.add(step, 'minute').isAfter(end)) {
            if (cursor.isBefore(now)) {
                cursor = cursor.add(step, 'minute');
                continue;
            }
            const slotStart = cursor.toDate();
            const slotEnd = addMinutes(slotStart, step);

            let free = false;
            if (!options.multiBarber) {
                free = !events.some((ev) => {
                    const { start, end: evEnd } = eventWindow(ev);
                    return rangesOverlap(slotStart, slotEnd, start, evEnd);
                });
            } else if (options.semPreferencia && options.barbers?.length) {
                free = options.barbers.some((b) =>
                    isBarberFreeAtSlot(events, slotStart, slotEnd, b.nome),
                );
            } else if (options.barberName) {
                free = isBarberFreeAtSlot(events, slotStart, slotEnd, options.barberName);
            } else if (options.barbers?.length) {
                free = options.barbers.some((b) =>
                    isBarberFreeAtSlot(events, slotStart, slotEnd, b.nome),
                );
            } else {
                free = true;
            }

            if (free) freeStarts.push(cursor);
            cursor = cursor.add(step, 'minute');
        }
    }

    if (!freeStarts.length) return 'nenhum horário livre neste dia';
    return formatAvailabilityByPeriod(freeStarts);
}

const DEFAULT_DAY_START_H = 8;
const DEFAULT_DAY_END_H = 20;

/**
 * Varre o dia em passos de `durationMin` e devolve os horários livres mais cedo
 * (qualquer profissional), com o nome de quem ficaria com o slot.
 */
export async function findEarliestSemPreferenciaSlots(
    email: string,
    dayIso: string,
    durationMin: number,
    barbers: BarberSlotRef[],
    maxSlots: number = 6,
): Promise<Array<{ label: string; barberName: string }>> {
    if (!barbers.length) return [];

    const day = startOfDay(parseISO(dayIso));
    const events = await listCalendarEvents(
        email,
        day.toISOString(),
        endOfDay(day).toISOString(),
    );

    const now = new Date();
    const results: Array<{ label: string; barberName: string }> = [];

    for (let h = DEFAULT_DAY_START_H; h < DEFAULT_DAY_END_H && results.length < maxSlots; h++) {
        for (let m = 0; m < 60 && results.length < maxSlots; m += durationMin) {
            const slotStart = new Date(day);
            slotStart.setHours(h, m, 0, 0);
            if (slotStart <= now) continue;

            const assignment = pickBarberForSemPreferenciaSlot(
                events,
                slotStart,
                durationMin,
                barbers,
            );
            if (assignment) {
                results.push({
                    label: formatTimeBR(slotStart),
                    barberName: assignment.barberName,
                });
            }
        }
    }

    return results;
}

/** Texto para a IA: horários mais cedo com Sem Preferência. */
export async function buildSemPreferenciaHintsForAi(
    email: string,
    referenceDateIso: string,
    durationMin: number,
    barbers: BarberSlotRef[],
): Promise<string> {
    const slots = await findEarliestSemPreferenciaSlots(
        email,
        referenceDateIso,
        durationMin,
        barbers,
        8,
    );
    if (!slots.length) {
        return 'SUGESTÕES_SEM_PREFERÊNCIA: nenhum horário livre encontrado hoje — ofereça outro dia.';
    }
    const lines = slots.map((s) => `${s.label} (${s.barberName})`);
    return `SUGESTÕES_SEM_PREFERÊNCIA (sempre ofereça o mais cedo primeiro): ${lines.join(', ')}`;
}
