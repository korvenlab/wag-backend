import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason, 
  fetchLatestBaileysVersion, 
  Browsers 
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import qrcode from 'qrcode';
import { Response } from 'express';

import { analyzeMessage, hasSchedulingIntent, isMultiBarberTeam } from './ai';
import {
  checkSchedulingAvailability,
  createEvent,
  getSchedulingBusyContext,
  buildSemPreferenciaHintsForAi,
  resolveSemPreferenciaBooking,
  findEventByPhone,
  deleteEvent,
} from './calendar';
import { pushAdminEvent } from './adminEvents';
import { profileHasWagooAccess } from '../lib/profileAccess';
import { listActiveBarbeirosForUser, resolveBarberFromSelection } from '../lib/barbeiros';
import { supabase } from '../lib/supabase';
export const sessions: Record<string, any> = {};

/**
 * 🧠 MEMÓRIA RAM VOLÁTIL (SaaS Ready)
 * Configurada para 10h de inatividade e histórico de 7 trocas completas.
 */
interface ChatContext {
  lastUpdate: number;
  messages: { role: 'user' | 'assistant', content: string }[];
  scheduling?: {
    barberConfirmed: boolean;
    selectedBarberName: string | null;
    selectedBarberEmail: string | null;
  };
}

const memoryCache: Record<string, ChatContext> = {};
const SESSION_EXPIRATION = 10 * 60 * 60 * 1000; 
const MAX_HISTORY = 14; 

export async function disconnectWhatsApp(email: string) {
  try {
    const sock = sessions[email];
    const baseAuthDir = path.join(__dirname, '..', '..', 'auth_info_baileys');
    const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
    const sessionDir = path.join(baseAuthDir, safeEmailFolder);

    if (sock) {
      sock.ev.removeAllListeners();
      try { await sock.logout(); } catch (e) {}
      try { sock.ws.close(); } catch (e) {}
      delete sessions[email];
    }

    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    await supabase.from('profiles').update({ whatsapp_session: null }).eq('email', email);
    pushAdminEvent('wagoo', 'Sessão WhatsApp encerrada pelo utilizador', 'offline');
    return { success: true };
  } catch (error) {
    console.error('Erro ao desconectar WhatsApp:', error);
    throw error;
  }
}

export async function startWhatsApp(email: string, res: Response | null) {
  try {
    if (sessions[email]) {
        sessions[email].ev.removeAllListeners();
        try { sessions[email].ws.close(); } catch(e) {}
        delete sessions[email];
    }

    const baseAuthDir = path.join(__dirname, '..', '..', 'auth_info_baileys');
    const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
    const sessionDir = path.join(baseAuthDir, safeEmailFolder);

    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { data: profile } = await supabase
      .from('profiles')
      .select('whatsapp_session')
      .eq('email', email)
      .single();

    const credsFilePath = path.join(sessionDir, 'creds.json');

    if (!fs.existsSync(credsFilePath) && profile?.whatsapp_session) {
      fs.writeFileSync(credsFilePath, JSON.stringify(profile.whatsapp_session));
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000
    });

    sessions[email] = sock;

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      try {
        if (fs.existsSync(credsFilePath)) {
          const fileContent = fs.readFileSync(credsFilePath, 'utf-8');
          if (fileContent && fileContent.trim().length > 0) {
            const credsData = JSON.parse(fileContent);
            await supabase.from('profiles').update({ whatsapp_session: credsData }).eq('email', email);
          }
        }
      } catch (parseError) {
        if (fs.existsSync(credsFilePath)) fs.unlinkSync(credsFilePath);
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && res && !res.headersSent) {
        const qrCodeImage = await qrcode.toDataURL(qr);
        res.status(200).json({ qrCode: qrCodeImage });
      }
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        if (sessions[email]) {
            sessions[email].ev.removeAllListeners();
            delete sessions[email];
        }
        if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 440 || statusCode === 403) {
          await supabase.from('profiles').update({ whatsapp_session: null }).eq('email', email);
          pushAdminEvent('wagoo', `Bot WhatsApp desconectado (${email})`, 'offline');
          if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
        } else {
          setTimeout(() => startWhatsApp(email, null), 5000);
        }
      } else if (connection === 'open') {
        console.log(`✅ [ATIVO] Bot online para: ${email}`);
        pushAdminEvent('wagoo', `Bot WhatsApp conectado (${email})`, 'online');
        if (res && !res.headersSent) res.status(200).json({ message: 'Conectado!' });
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.endsWith('@g.us')) return;

      const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!textMessage) return;

      const now = Date.now();
      const cacheKey = `${email}:${remoteJid}`; 

      try {
        const { data: p } = await supabase.from('profiles').select('*').eq('email', email).single();
        if (!p || !profileHasWagooAccess(p as { has_paid?: boolean; complimentary_access_until?: string | null }) || !p.is_ai_enabled) return;

        const sessionExists = !!memoryCache[cacheKey];
        const isExpired = sessionExists && (now - memoryCache[cacheKey].lastUpdate > SESSION_EXPIRATION);
        const activeSession = sessionExists && !isExpired;

        if (!activeSession && !hasSchedulingIntent(textMessage)) {
            return; 
        }

        if (!activeSession) {
            console.log(`🎯 [ATIVADO] Intenção detectada para ${cacheKey}.`);
            memoryCache[cacheKey] = {
              lastUpdate: now,
              messages: [],
              scheduling: { barberConfirmed: false, selectedBarberName: null, selectedBarberEmail: null },
            };
        }

        memoryCache[cacheKey].lastUpdate = now;
        memoryCache[cacheKey].messages.push({ role: 'user', content: textMessage });

        const activeBarbeiros = await listActiveBarbeirosForUser(p.id);
        const multiBarber = isMultiBarberTeam(
          activeBarbeiros.map((b) => ({ id: b.id, nome: b.nome })),
        );

        if (!memoryCache[cacheKey].scheduling) {
          memoryCache[cacheKey].scheduling = {
            barberConfirmed: false,
            selectedBarberName: null,
            selectedBarberEmail: null,
          };
        }

        if (!multiBarber && activeBarbeiros.length === 1) {
          const only = activeBarbeiros[0];
          memoryCache[cacheKey].scheduling = {
            barberConfirmed: true,
            selectedBarberName: only.nome,
            selectedBarberEmail: only.google_calendar_email,
          };
        } else if (!multiBarber && activeBarbeiros.length === 0) {
          memoryCache[cacheKey].scheduling = {
            barberConfirmed: true,
            selectedBarberName: null,
            selectedBarberEmail: null,
          };
        }

        const schedulingState = memoryCache[cacheKey].scheduling!;

        const currentHistory = memoryCache[cacheKey].messages.slice(-MAX_HISTORY);
        const formattedHistory = currentHistory
            .map(h => `${h.role === 'user' ? 'Cliente' : 'Wagoo'}: ${h.content}`)
            .join('\n');

        const schedForBusy = memoryCache[cacheKey].scheduling!;
        const semPreferencia =
          schedForBusy.selectedBarberName?.toLowerCase().includes('sem prefer') ?? false;
        const barberRefs = activeBarbeiros.map((b) => ({
          nome: b.nome,
          google_calendar_email: b.google_calendar_email,
        }));
        let busySlots = await getSchedulingBusyContext(email, new Date().toISOString(), {
          multiBarber,
          barberName: semPreferencia ? null : schedForBusy.selectedBarberName,
          semPreferencia,
          activeBarberNames: activeBarbeiros.map((b) => b.nome),
        });
        if (multiBarber && semPreferencia && schedForBusy.barberConfirmed) {
          const hints = await buildSemPreferenciaHintsForAi(
            email,
            new Date().toISOString(),
            p.service_duration ?? 30,
            barberRefs,
          );
          busySlots = [...busySlots, hints];
        }

        const aiResult = await analyzeMessage(
          formattedHistory,
          textMessage,
          true,
          false,
          busySlots,
          {
            store_name: p.store_name,
            working_hours: p.working_hours,
            service_duration: p.service_duration,
          },
          activeBarbeiros.map((b) => ({ id: b.id, nome: b.nome })),
          {
            barberConfirmed: schedulingState.barberConfirmed,
            selectedBarberName: schedulingState.selectedBarberName,
          },
        );

        if (multiBarber && aiResult.barberConfirmed && aiResult.barberSelection) {
          const resolved = resolveBarberFromSelection(activeBarbeiros, aiResult.barberSelection);
          if (resolved) {
            memoryCache[cacheKey].scheduling = {
              barberConfirmed: true,
              selectedBarberName: resolved.nome,
              selectedBarberEmail: resolved.email,
            };
          }
        }

        // --- 🗑️ CANCELAMENTO ---
        if (aiResult.isCancelling) {
            const clientPhone = remoteJid.split('@')[0];
            const event = await findEventByPhone(email, clientPhone);

            if (event) {
                const success = await deleteEvent(email, event.id);
                if (success) {
                    const eventDate = new Date(event.start.dateTime).toLocaleString('pt-BR');
                    await sock.sendMessage(remoteJid, { 
                        text: `Certo. Localizei seu agendamento para ${eventDate} e ele foi cancelado com sucesso.` 
                    });
                    delete memoryCache[cacheKey]; 
                    return;
                }
            } else {
                await sock.sendMessage(remoteJid, { 
                    text: "Não encontrei nenhum agendamento futuro para o seu número." 
                });
                return;
            }
        }

        if (aiResult.response) {
          try {
              await sock.sendMessage(remoteJid, { text: aiResult.response });
              memoryCache[cacheKey].messages.push({ role: 'assistant', content: aiResult.response });
              
              if (memoryCache[cacheKey].messages.length > MAX_HISTORY) {
                  memoryCache[cacheKey].messages = memoryCache[cacheKey].messages.slice(-MAX_HISTORY);
              }

              await supabase.from('profiles').update({ messages_answered: (p.messages_answered || 0) + 1 }).eq('email', email);
          } catch (sendError) {
              console.error(`❌ Erro no envio para ${remoteJid}`);
          }
        }

        // --- 🎯 AGENDAMENTO ---
        if (aiResult.isScheduling && aiResult.date) {
            const sched = memoryCache[cacheKey].scheduling;
            const semPref =
              sched?.selectedBarberName?.toLowerCase().includes('sem prefer') ?? false;
            const barberName = multiBarber
              ? sched?.selectedBarberName ?? 'Sem Preferência'
              : activeBarbeiros.length === 1
                ? activeBarbeiros[0].nome
                : undefined;
            const barberEmail = multiBarber
              ? sched?.selectedBarberEmail ?? null
              : activeBarbeiros.length === 1
                ? activeBarbeiros[0].google_calendar_email
                : null;

            let finalBarberName = barberName;
            let finalBarberEmail = barberEmail;

            if (semPref && multiBarber) {
              const assigned = await resolveSemPreferenciaBooking(
                email,
                aiResult.date,
                p.service_duration ?? 30,
                barberRefs,
              );
              if (!assigned) {
                await sock.sendMessage(remoteJid, {
                  text: 'Esse horário não está disponível. Posso sugerir o próximo horário mais cedo — qual dia prefere?',
                });
                return;
              }
              finalBarberName = assigned.barberName;
              finalBarberEmail = assigned.barberEmail;
            } else {
              const isFree = await checkSchedulingAvailability(
                email,
                aiResult.date,
                p.service_duration ?? 30,
                {
                  multiBarber,
                  barberName: sched?.selectedBarberName ?? null,
                  semPreferencia: false,
                  activeBarberNames: activeBarbeiros.map((b) => b.nome),
                },
              );
              if (!isFree) {
                await sock.sendMessage(remoteJid, {
                  text: multiBarber && barberName
                    ? `Esse horário não está livre para ${barberName}. Posso sugerir outro horário ou outro profissional — o que prefere?`
                    : 'Esse horário acabou de ser ocupado. Quer tentar outro horário?',
                });
                return;
              }
            }

            {
                const clientName = msg.pushName || "Cliente WhatsApp";
                const clientPhone = remoteJid.split('@')[0];
                const created = await createEvent(
                  email,
                  clientName,
                  clientPhone,
                  aiResult.date,
                  p.service_duration,
                  { barberName: finalBarberName, barberEmail: finalBarberEmail },
                );

                if (created) {
                    const confirmDate = new Date(aiResult.date).toLocaleString('pt-BR', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    });
                    const profLine =
                      multiBarber && finalBarberName
                        ? `\nProfissional: ${finalBarberName}`
                        : '';
                    await sock.sendMessage(remoteJid, {
                      text: `Perfeito! Seu horário está confirmado para ${confirmDate}.${profLine}\nAté lá!`,
                    });
                    await supabase.from('profiles').update({
                        appointments_count: (p.appointments_count || 0) + 1
                    }).eq('email', email);
                    delete memoryCache[cacheKey];
                }
            }
        }
      } catch (err) { console.error("Erro Lucy:", err); }
    });
  } catch (error) { console.error('Erro startWhatsApp:', error); }
}

export async function autoReconnectAll() {
  const { data: profiles } = await supabase
    .from('profiles')
    .select('email, has_paid, complimentary_access_until, is_ai_enabled')
    .eq('is_ai_enabled', true);
  const eligible = (profiles ?? []).filter((p) =>
    profileHasWagooAccess(p as { has_paid?: boolean; complimentary_access_until?: string | null }),
  );
  eligible.forEach((p) => startWhatsApp(p.email, null));
}
