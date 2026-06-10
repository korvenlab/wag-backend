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
import {
  bundleLooksComplete,
  clearWhatsAppSessionInSupabase,
  persistWhatsAppSessionToSupabase,
  restoreWhatsAppSessionToDisk,
  schedulePersistWhatsAppSession,
  sessionDirLooksComplete,
} from '../lib/whatsappSessionStore';
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

/** Evita processar a mesma mensagem 2x (@lid + @s.whatsapp.net ou retry do Baileys). */
const recentlyProcessed = new Map<string, number>();
const inFlightMessages = new Set<string>();
const MESSAGE_DEDUPE_TTL_MS = 5 * 60 * 1000;

type IncomingWaMessage = {
  key: {
    id?: string | null;
    remoteJid?: string | null;
    remoteJidAlt?: string | null;
    fromMe?: boolean | null;
  };
  messageTimestamp?: number | Long | null;
  pushName?: string | null;
  message?: unknown;
};

type Long = { toNumber?: () => number };

function messageTimestampMs(ts: number | Long | null | undefined): number {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts > 1e12 ? ts : ts * 1000;
  if (typeof ts.toNumber === 'function') {
    const n = ts.toNumber();
    return n > 1e12 ? n : n * 1000;
  }
  return 0;
}

function messageDedupeKey(email: string, msg: IncomingWaMessage): string {
  const id = msg.key.id?.trim();
  if (id) return `${email}:msg:${id}`;
  const jid = msg.key.remoteJidAlt ?? msg.key.remoteJid ?? 'unknown';
  return `${email}:ts:${jid}:${messageTimestampMs(msg.messageTimestamp)}`;
}

function shouldSkipDuplicateMessage(dedupeKey: string): boolean {
  if (inFlightMessages.has(dedupeKey)) return true;
  const seenAt = recentlyProcessed.get(dedupeKey);
  return seenAt != null && Date.now() - seenAt < MESSAGE_DEDUPE_TTL_MS;
}

function beginMessageProcessing(dedupeKey: string): void {
  inFlightMessages.add(dedupeKey);
}

function finishMessageProcessing(dedupeKey: string): void {
  inFlightMessages.delete(dedupeKey);
  recentlyProcessed.set(dedupeKey, Date.now());
  if (recentlyProcessed.size > 500) {
    const cutoff = Date.now() - MESSAGE_DEDUPE_TTL_MS;
    for (const [key, at] of recentlyProcessed) {
      if (at < cutoff) recentlyProcessed.delete(key);
    }
  }
}

/** Unifica sessão RAM entre @lid e número @s.whatsapp.net do mesmo cliente. */
function stableCacheKey(email: string, msg: IncomingWaMessage): string {
  const alt = msg.key.remoteJidAlt ?? '';
  const jid = msg.key.remoteJid ?? '';
  const preferred =
    alt.endsWith('@s.whatsapp.net') ? alt :
    jid.endsWith('@s.whatsapp.net') ? jid :
    alt || jid;
  const phone = preferred.split('@')[0].replace(/\D/g, '');
  return phone ? `${email}:${phone}` : `${email}:${preferred}`;
}

function replyJid(msg: IncomingWaMessage): string {
  return msg.key.remoteJidAlt ?? msg.key.remoteJid ?? '';
}

function isBaileysCryptoError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('unable to authenticate data') ||
    msg.includes('Unsupported state') ||
    msg.includes('bad decrypt') ||
    msg.includes('cipher')
  );
}

async function purgeWhatsAppSession(email: string, reason: string): Promise<void> {
  const baseAuthDir = path.join(__dirname, '..', '..', 'auth_info_baileys');
  const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
  const sessionDir = path.join(baseAuthDir, safeEmailFolder);

  const sock = sessions[email];
  if (sock) {
    sock.ev.removeAllListeners();
    try {
      sock.ws?.removeAllListeners?.();
    } catch {
      /* ignore */
    }
    try {
      await sock.logout();
    } catch {
      /* ignore */
    }
    try {
      sock.ws?.close?.();
    } catch {
      /* ignore */
    }
    delete sessions[email];
  }

  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }

  await clearWhatsAppSessionInSupabase(email);
  console.warn(`[WAGOO WA] Sessão removida (${email}): ${reason}`);
  pushAdminEvent('wagoo', `Sessão WhatsApp inválida — novo QR necessário (${email})`, 'offline');
}

let processSafetyInstalled = false;

/** Impede que erro crypto do Baileys derrube a API no Render. */
export function installWhatsAppProcessSafetyNet(): void {
  if (processSafetyInstalled) return;
  processSafetyInstalled = true;

  process.on('uncaughtException', (err) => {
    if (isBaileysCryptoError(err)) {
      console.error('[WAGOO WA] uncaughtException (sessão inválida, API continua):', err.message);
      return;
    }
    console.error('[WAGOO] uncaughtException:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    if (isBaileysCryptoError(reason)) {
      console.error(
        '[WAGOO WA] unhandledRejection (sessão inválida, API continua):',
        reason instanceof Error ? reason.message : String(reason),
      );
      return;
    }
    console.error('[WAGOO] unhandledRejection:', reason);
  });
}

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

    await clearWhatsAppSessionInSupabase(email);
    pushAdminEvent('wagoo', 'Sessão WhatsApp encerrada pelo utilizador', 'offline');
    return { success: true };
  } catch (error) {
    console.error('Erro ao desconectar WhatsApp:', error);
    throw error;
  }
}

export async function startWhatsApp(email: string, res: Response | null) {
  const baseAuthDir = path.join(__dirname, '..', '..', 'auth_info_baileys');
  const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
  const sessionDir = path.join(baseAuthDir, safeEmailFolder);

  try {
    if (sessions[email]) {
        sessions[email].ev.removeAllListeners();
        try { sessions[email].ws?.removeAllListeners?.(); } catch(e) {}
        try { sessions[email].ws.close(); } catch(e) {}
        delete sessions[email];
    }

    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { data: profile } = await supabase
      .from('profiles')
      .select('whatsapp_session')
      .eq('email', email)
      .single();

    const storedSession = profile?.whatsapp_session;

    if (!sessionDirLooksComplete(sessionDir) && storedSession) {
      const restored = restoreWhatsAppSessionToDisk(sessionDir, storedSession);
      if (restored) {
        console.log(`[WAGOO WA] Sessão completa restaurada do Supabase (${email})`);
      }
    }

    const hasCompleteStoredSession = bundleLooksComplete(storedSession);
    const sessionComplete = sessionDirLooksComplete(sessionDir);

    // Auto-reconnect: bundle v1 (só creds) ou pasta incompleta — aguarda novo QR.
    if (!res && storedSession && !sessionComplete && !hasCompleteStoredSession) {
      console.warn(
        `[WAGOO WA] Sessão legada/incompleta para ${email}. Escaneie QR uma vez para activar persistência completa.`,
      );
      return;
    }

    // Novo QR: descarta credenciais parciais.
    if (res && storedSession && !sessionComplete && !hasCompleteStoredSession) {
      await purgeWhatsAppSession(email, 'sessão incompleta — novo pareamento');
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
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

    const onSocketFailure = (err: unknown) => {
      if (!isBaileysCryptoError(err)) {
        console.error(`[WAGOO WA] Erro socket (${email}):`, err);
        return;
      }
      console.error(`[WAGOO WA] Crypto inválido (${email}) — limpando sessão.`);
      void purgeWhatsAppSession(email, 'chaves de sessão corrompidas ou incompletas');
    };

    sock.ws?.on?.('error', onSocketFailure);
    sock.ws?.on?.('close', (code: number) => {
      if (code >= 1002) {
        console.warn(`[WAGOO WA] WebSocket fechou (${email}) code=${code}`);
      }
    });

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      schedulePersistWhatsAppSession(email, sessionDir);
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && res && !res.headersSent) {
        const qrCodeImage = await qrcode.toDataURL(qr);
        res.status(200).json({ qrCode: qrCodeImage });
      }
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const disconnectMsg = (lastDisconnect?.error as Error)?.message ?? '';
        if (sessions[email]) {
            sessions[email].ev.removeAllListeners();
            try { sessions[email].ws?.removeAllListeners?.(); } catch(e) {}
            delete sessions[email];
        }
        if (
          statusCode === DisconnectReason.loggedOut ||
          statusCode === 401 ||
          statusCode === 440 ||
          statusCode === 403 ||
          isBaileysCryptoError(lastDisconnect?.error)
        ) {
          await purgeWhatsAppSession(
            email,
            isBaileysCryptoError(lastDisconnect?.error)
              ? 'desconexão por chave inválida'
              : `logout (${statusCode ?? disconnectMsg})`,
          );
        } else {
          setTimeout(() => {
            startWhatsApp(email, null).catch((err) => {
              console.error(`[WAGOO WA] Falha ao reconectar ${email}:`, err);
            });
          }, 5000);
        }
      } else if (connection === 'open') {
        console.log(`✅ [ATIVO] Bot online para: ${email}`);
        pushAdminEvent('wagoo', `Bot WhatsApp conectado (${email})`, 'online');
        await persistWhatsAppSessionToSupabase(email, sessionDir);
        if (res && !res.headersSent) res.status(200).json({ message: 'Conectado!' });
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;

      const msg = m.messages[0] as IncomingWaMessage;
      if (!msg.message || msg.key.fromMe) return;

      const remoteJid = replyJid(msg);
      if (!remoteJid || remoteJid.endsWith('@g.us')) return;

      const textMessage =
        (msg.message as { conversation?: string }).conversation ||
        (msg.message as { extendedTextMessage?: { text?: string } }).extendedTextMessage?.text;
      if (!textMessage) return;

      const dedupeKey = messageDedupeKey(email, msg);
      if (shouldSkipDuplicateMessage(dedupeKey)) {
        return;
      }
      beginMessageProcessing(dedupeKey);

      const now = Date.now();
      const cacheKey = stableCacheKey(email, msg);

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
            const clientPhone = remoteJid.split('@')[0].replace(/\D/g, '');
            const event = await findEventByPhone(email, clientPhone);

            if (event) {
                const success = await deleteEvent(email, event.id);
                if (success) {
                    const eventDate = new Date(event.start.dateTime).toLocaleString('pt-BR');
                    await sock.sendMessage(remoteJid, { 
                        text: `Agendamento de ${eventDate} cancelado.`
                    });
                    delete memoryCache[cacheKey]; 
                    return;
                }
            } else {
                await sock.sendMessage(remoteJid, { 
                    text: 'Não encontrei agendamento futuro no seu número.'
                });
                return;
            }
        }

        const willCreateAppointment = Boolean(aiResult.isScheduling && aiResult.date);

        if (aiResult.response && !willCreateAppointment) {
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
        if (willCreateAppointment && aiResult.date) {
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
                  text: 'Horário indisponível. Quer outro dia ou horário?',
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
                    ? `Horário indisponível para ${barberName}. Outro horário ou profissional?`
                    : 'Horário indisponível. Quer tentar outro?',
                });
                return;
              }
            }

            {
                const clientName = msg.pushName || "Cliente WhatsApp";
                const clientPhone = remoteJid.split('@')[0].replace(/\D/g, '');
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
                    const confirmText = `Confirmado: ${confirmDate}.${profLine}\nAté lá!`;
                    await sock.sendMessage(remoteJid, { text: confirmText });
                    memoryCache[cacheKey].messages.push({ role: 'assistant', content: confirmText });
                    await supabase.from('profiles').update({
                        messages_answered: (p.messages_answered || 0) + 1,
                        appointments_count: (p.appointments_count || 0) + 1
                    }).eq('email', email);
                    delete memoryCache[cacheKey];
                } else if (aiResult.response) {
                    await sock.sendMessage(remoteJid, { text: aiResult.response });
                }
            }
        }
      } catch (err) { console.error("Erro Lucy:", err); }
      finally {
        finishMessageProcessing(dedupeKey);
      }
    });
  } catch (error) {
    console.error('Erro startWhatsApp:', error);
    if (isBaileysCryptoError(error)) {
      await purgeWhatsAppSession(email, 'falha ao iniciar com credenciais inválidas');
    }
  }
}

export async function autoReconnectAll() {
  const { data: profiles } = await supabase
    .from('profiles')
    .select('email, has_paid, complimentary_access_until, is_ai_enabled')
    .eq('is_ai_enabled', true);
  const eligible = (profiles ?? []).filter((p) =>
    profileHasWagooAccess(p as { has_paid?: boolean; complimentary_access_until?: string | null }),
  );

  for (const p of eligible) {
    try {
      await startWhatsApp(p.email, null);
    } catch (err) {
      console.error(`[WAGOO WA] autoReconnect falhou (${p.email}):`, err);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
