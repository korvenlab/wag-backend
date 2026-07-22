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
  listFreeBarbersAtSlot,
  buildFreeRangesSummary,
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
import { log } from '../lib/logger';
import {
  formatDateTimeBR,
  formatHourCompact,
  isAffirmativeBooking,
  isAskingProfessionalAvailability,
  isNegativeBooking,
  resolveAvailabilityDayFromMessage,
  startOfDayBR,
} from '../lib/dateTimeBR';
import {
  cancelAppointmentReminder,
  enqueueAppointmentReminder,
  tryHandlePresenceConfirmation,
} from './reminders';
import {
  normalizeResponseTemplates,
  resolveAfterBookingReply,
  resolveCancelReply,
  type ResponseTemplates,
} from '../lib/responseTemplates';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

export const sessions: Record<string, any> = {};

/** Último QR por e-mail — Baileys renova o QR; a HTTP response só consegue enviar o 1º. */
const pendingQrByEmail: Record<string, string> = {};
/** Após scan, Baileys manda 515 e precisa reiniciar com o mesmo creds.json. */
const pairingRestartByEmail = new Set<string>();
/** Evita dois startWhatsApp em paralelo (ex.: poll + reconnect). */
const startInFlightByEmail = new Set<string>();
const WA = 'WA';

function sessionHasCreds(sessionDir: string): boolean {
  try {
    return fs.existsSync(path.join(sessionDir, 'creds.json'));
  } catch {
    return false;
  }
}

function scheduleReconnect(email: string, delayMs: number, reason: string): void {
  log.step(WA, `agendando reconnect (${reason})`, { email, delayMs });
  setTimeout(() => {
    startWhatsApp(email, null).catch((err) => {
      log.error(WA, 'falha ao reconectar', err, { email, reason });
    });
  }, delayMs);
}

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
    /** Aguardando "sim" do cliente antes de criar no Google Calendar. */
    pendingConfirmation?: {
      dateIso: string;
      barberName: string | null;
      barberEmail: string | null;
    } | null;
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

  delete pendingQrByEmail[email];
  pairingRestartByEmail.delete(email);

  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }

  await clearWhatsAppSessionInSupabase(email);
  log.warn(WA, 'Sessão removida', { email, reason });
  pushAdminEvent('wagoo', `Sessão WhatsApp inválida — novo QR necessário (${email})`, 'offline');
}

let processSafetyInstalled = false;

/** Impede que erro crypto do Baileys derrube a API no Render. */
export function installWhatsAppProcessSafetyNet(): void {
  if (processSafetyInstalled) return;
  processSafetyInstalled = true;

  process.on('uncaughtException', (err) => {
    if (isBaileysCryptoError(err)) {
      log.error(WA, 'uncaughtException — sessão inválida (API continua)', err);
      return;
    }
    log.error('CORE', 'uncaughtException fatal', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    if (isBaileysCryptoError(reason)) {
      log.error(WA, 'unhandledRejection — sessão inválida (API continua)', reason);
      return;
    }
    log.error('CORE', 'unhandledRejection', reason);
  });
}

export async function disconnectWhatsApp(email: string) {
  try {
    log.step(WA, 'disconnect solicitado', { email });
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

    delete pendingQrByEmail[email];
    pairingRestartByEmail.delete(email);

    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    await clearWhatsAppSessionInSupabase(email);
    pushAdminEvent('wagoo', 'Sessão WhatsApp encerrada pelo utilizador', 'offline');
    log.info(WA, 'disconnect concluído', { email });
    return { success: true };
  } catch (error) {
    log.error(WA, 'Erro ao desconectar WhatsApp', error, { email });
    throw error;
  }
}

export async function startWhatsApp(email: string, res: Response | null) {
  const baseAuthDir = path.join(__dirname, '..', '..', 'auth_info_baileys');
  const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
  const sessionDir = path.join(baseAuthDir, safeEmailFolder);
  const mode = res ? 'qr' : 'reconnect';

  try {
    log.step(WA, 'startWhatsApp', { email, mode });

    // Já online — não derruba o socket pedindo QR de novo.
    if (sessions[email]?.user && res && !res.headersSent) {
      pairingRestartByEmail.delete(email);
      log.info(WA, 'já conectado — QR dispensado', { email });
      res.status(200).json({ message: 'Conectado!', connected: true, status: 'connected' });
      return;
    }

    // Handshake pós-515 em andamento: avisa o front e deixa o reconnect seguir.
    if (res && pairingRestartByEmail.has(email)) {
      log.info(WA, 'handshake pós-scan em curso', { email, hasSocket: !!sessions[email] });
      if (!res.headersSent) {
        res.status(200).json({
          status: 'connecting',
          message: 'Conectando… finalize no celular se pedir.',
        });
      }
      if (!sessions[email] && !startInFlightByEmail.has(email)) {
        scheduleReconnect(email, 300, 'pairing-restart-poll');
      }
      return;
    }

    // Pareamento em curso: devolve o QR atual (sempre o pending mais recente).
    if (sessions[email] && res && pendingQrByEmail[email] && !res.headersSent) {
      log.info(WA, 'reutilizando QR pendente (socket vivo)', { email });
      res.status(200).json({
        qrCode: pendingQrByEmail[email],
        status: 'waiting_qr',
      });
      return;
    }

    if (startInFlightByEmail.has(email)) {
      log.warn(WA, 'startWhatsApp já em progresso — ignorando chamada paralela', { email, mode });
      if (res && !res.headersSent) {
        if (pendingQrByEmail[email]) {
          res.status(200).json({ qrCode: pendingQrByEmail[email], status: 'waiting_qr' });
        } else if (pairingRestartByEmail.has(email)) {
          res.status(200).json({ status: 'connecting', message: 'Conectando…' });
        } else {
          res.status(200).json({ status: 'connecting', message: 'Iniciando conexão…' });
        }
      }
      return;
    }
    startInFlightByEmail.add(email);

    if (sessions[email]) {
        log.warn(WA, 'substituindo socket existente', { email, mode });
        sessions[email].ev.removeAllListeners();
        try { sessions[email].ws?.removeAllListeners?.(); } catch(e) {}
        try { sessions[email].ws.close(); } catch(e) {}
        delete sessions[email];
    }
    delete pendingQrByEmail[email];

    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('whatsapp_session')
      .eq('email', email)
      .single();

    if (profileErr) {
      log.warn(WA, 'falha ao ler whatsapp_session no Supabase', {
        email,
        error: profileErr.message,
      });
    }

    const storedSession = profile?.whatsapp_session;
    const hasCompleteStoredSession = bundleLooksComplete(storedSession);
    const diskFilesBefore = fs.existsSync(sessionDir)
      ? fs.readdirSync(sessionDir).filter((n) => !n.startsWith('.')).length
      : 0;
    const hasCreds = sessionHasCreds(sessionDir);

    log.info(WA, 'estado da sessão antes do start', {
      email,
      mode,
      hasStored: !!storedSession,
      storedComplete: hasCompleteStoredSession,
      diskFiles: diskFilesBefore,
      hasCreds,
      pairingRestart: pairingRestartByEmail.has(email),
    });

    // Só restaura bundle completo — incompleto (só creds) NÃO vai para o disco.
    if (!sessionDirLooksComplete(sessionDir) && hasCompleteStoredSession) {
      const restored = restoreWhatsAppSessionToDisk(sessionDir, storedSession);
      if (restored) {
        log.info(WA, 'sessão completa restaurada do Supabase', { email });
      } else {
        log.warn(WA, 'restore do Supabase falhou (bundle incompleto após escrita)', { email });
      }
    }

    const sessionComplete = sessionDirLooksComplete(sessionDir);

    // Auto-reconnect: com creds.json (mesmo incompleto) = pós-QR 515 → continuar handshake.
    // Sem creds = nada a reconectar.
    if (!res && !sessionComplete && !hasCompleteStoredSession) {
      if (sessionHasCreds(sessionDir)) {
        log.step(WA, 'reconnect com creds parcial (pós-scan / 515)', { email });
        // fall through → makeWASocket
      } else {
        if (storedSession) {
          log.warn(WA, 'reconnect sem creds no disco — limpando lixo Supabase', { email });
          await clearWhatsAppSessionInSupabase(email);
        } else {
          log.info(WA, 'reconnect sem sessão — nada a fazer', { email });
        }
        pairingRestartByEmail.delete(email);
        return;
      }
    }

    // QR: NÃO apagar creds se restart 515 pendente.
    // Pedido explícito de QR sem restart → limpa parcial órfão e gera QR novo.
    if (res && !sessionComplete && !hasCompleteStoredSession) {
      if (sessionHasCreds(sessionDir) && pairingRestartByEmail.has(email)) {
        log.step(WA, 'mantendo creds pós-515 — abrindo socket de novo', { email });
        if (!res.headersSent) {
          res.status(200).json({
            status: 'connecting',
            message: 'Conectando…',
          });
        }
        res = null;
      } else if (sessionHasCreds(sessionDir) || diskFilesBefore > 0) {
        await clearWhatsAppSessionInSupabase(email);
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        fs.mkdirSync(sessionDir, { recursive: true });
        pairingRestartByEmail.delete(email);
        log.step(WA, 'pasta limpa para novo pareamento', { email });
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    log.info(WA, 'abrindo socket Baileys', { email, baileysVersion: version?.join?.('.') ?? version });

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
        log.error(WA, 'erro no websocket', err, { email });
        return;
      }
      log.error(WA, 'crypto inválido — limpando sessão', err, { email });
      pairingRestartByEmail.delete(email);
      void purgeWhatsAppSession(email, 'chaves de sessão corrompidas ou incompletas');
    };

    sock.ws?.on?.('error', onSocketFailure);
    sock.ws?.on?.('close', (code: number) => {
      if (code >= 1002) {
        log.warn(WA, 'websocket fechou', { email, code });
      }
    });

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      const files = fs.existsSync(sessionDir)
        ? fs.readdirSync(sessionDir).filter((n) => !n.startsWith('.')).length
        : 0;
      log.info(WA, 'creds.update', {
        email,
        diskFiles: files,
        complete: sessionDirLooksComplete(sessionDir),
      });
      schedulePersistWhatsAppSession(email, sessionDir);
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (connection) {
        log.step(WA, `connection=${connection}`, { email });
      }
      if (qr) {
        pairingRestartByEmail.delete(email);
        try {
          const qrCodeImage = await qrcode.toDataURL(qr);
          pendingQrByEmail[email] = qrCodeImage;
          const sentToClient = !!(res && !res.headersSent);
          if (sentToClient) {
            res!.status(200).json({ qrCode: qrCodeImage, status: 'waiting_qr' });
          }
          log.info(WA, 'QR gerado/atualizado', { email, sentToClient });
        } catch (qrErr) {
          log.error(WA, 'falha ao gerar imagem do QR', qrErr, { email });
        }
      }
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const disconnectMsg = (lastDisconnect?.error as Error)?.message ?? '';
        const hasCredsNow = sessionHasCreds(sessionDir);
        const completeNow = sessionDirLooksComplete(sessionDir);
        log.warn(WA, 'conexão fechada', {
          email,
          statusCode,
          disconnectMsg,
          completeOnDisk: completeNow,
          hasCreds: hasCredsNow,
        });
        if (sessions[email]) {
            sessions[email].ev.removeAllListeners();
            try { sessions[email].ws?.removeAllListeners?.(); } catch(e) {}
            delete sessions[email];
        }
        delete pendingQrByEmail[email];

        const isRestartRequired =
          statusCode === DisconnectReason.restartRequired || statusCode === 515;
        const isLoggedOut =
          statusCode === DisconnectReason.loggedOut ||
          statusCode === 401 ||
          statusCode === 440 ||
          statusCode === 403 ||
          isBaileysCryptoError(lastDisconnect?.error);

        if (isLoggedOut) {
          pairingRestartByEmail.delete(email);
          await purgeWhatsAppSession(
            email,
            isBaileysCryptoError(lastDisconnect?.error)
              ? 'desconexão por chave inválida'
              : `logout (${statusCode ?? disconnectMsg})`,
          );
        } else if (isRestartRequired) {
          // Normal após escanear o QR — reconectar com o mesmo creds.json.
          pairingRestartByEmail.add(email);
          log.step(WA, '515 restartRequired após scan — reconectando com creds', { email });
          scheduleReconnect(email, 1200, '515-restart-required');
        } else if (completeNow || hasCredsNow) {
          pairingRestartByEmail.add(email);
          scheduleReconnect(email, 3000, completeNow ? 'session-complete' : 'has-creds');
        } else {
          pairingRestartByEmail.delete(email);
          log.warn(WA, 'fechou sem creds — usuário deve gerar QR de novo', { email });
        }
      } else if (connection === 'open') {
        log.info(WA, 'BOT ONLINE', { email });
        pairingRestartByEmail.delete(email);
        delete pendingQrByEmail[email];
        pushAdminEvent('wagoo', `Bot WhatsApp conectado (${email})`, 'online');
        await persistWhatsAppSessionToSupabase(email, sessionDir);
        if (res && !res.headersSent) {
          res.status(200).json({ message: 'Conectado!', connected: true, status: 'connected' });
        }
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
        if (!p || !profileHasWagooAccess(p as { has_paid?: boolean; complimentary_access_until?: string | null })) {
          return;
        }

        const clientPhoneDigits = remoteJid.split('@')[0].replace(/\D/g, '');
        const presenceHandled = await tryHandlePresenceConfirmation({
          userId: p.id as string,
          clientPhone: clientPhoneDigits,
          text: textMessage,
          sendReply: async (text) => {
            await sock.sendMessage(remoteJid, { text });
          },
        });
        if (presenceHandled) return;

        if (!p.is_ai_enabled) return;

        const templates: ResponseTemplates = normalizeResponseTemplates(p.response_templates);

        const sessionExists = !!memoryCache[cacheKey];
        const isExpired = sessionExists && (now - memoryCache[cacheKey].lastUpdate > SESSION_EXPIRATION);
        const activeSession = sessionExists && !isExpired;

        if (!activeSession && !hasSchedulingIntent(textMessage)) {
            return; 
        }

        if (!activeSession) {
            log.info(WA, 'intenção de agendamento detectada', { cacheKey });
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
            pendingConfirmation: null,
          };
        }

        if (!multiBarber && activeBarbeiros.length === 1) {
          const only = activeBarbeiros[0];
          const prev = memoryCache[cacheKey].scheduling!;
          memoryCache[cacheKey].scheduling = {
            ...prev,
            barberConfirmed: true,
            selectedBarberName: only.nome,
            selectedBarberEmail: only.google_calendar_email,
          };
        } else if (!multiBarber && activeBarbeiros.length === 0) {
          const prev = memoryCache[cacheKey].scheduling!;
          memoryCache[cacheKey].scheduling = {
            ...prev,
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
        const requestedDay = resolveAvailabilityDayFromMessage(textMessage);
        const dayIsoForRanges = requestedDay.dayIso;
        const dayLabel = requestedDay.label;
        const dayStartIso = startOfDayBR(dayIsoForRanges).toISOString();
        let busySlots = await getSchedulingBusyContext(email, dayStartIso, {
          multiBarber,
          barberName: semPreferencia ? null : schedForBusy.selectedBarberName,
          semPreferencia,
          activeBarberNames: activeBarbeiros.map((b) => b.nome),
        });
        if (multiBarber && semPreferencia && schedForBusy.barberConfirmed) {
          const hints = await buildSemPreferenciaHintsForAi(
            email,
            dayStartIso,
            p.service_duration ?? 30,
            barberRefs,
          );
          busySlots = [...busySlots, hints];
        }

        // Multi sem profissional escolhido: resume quem tem vaga (qualquer um).
        const freeRangesSummary = await buildFreeRangesSummary(
          email,
          dayIsoForRanges,
          p.service_duration ?? 30,
          p.working_hours,
          {
            multiBarber,
            barberName:
              multiBarber && !schedForBusy.barberConfirmed
                ? null
                : semPreferencia
                  ? null
                  : schedForBusy.selectedBarberName,
            semPreferencia:
              semPreferencia || (multiBarber && !schedForBusy.barberConfirmed),
            barbers: barberRefs,
          },
        );
        const freeRangesLabeled =
          freeRangesSummary && !/nenhum horário livre/i.test(freeRangesSummary)
            ? `${dayLabel}: ${freeRangesSummary}`
            : freeRangesSummary;

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
            business_niche: p.business_niche,
            business_niche_custom: p.business_niche_custom,
            free_ranges_summary: freeRangesLabeled || null,
            response_templates: templates,
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
              ...memoryCache[cacheKey].scheduling!,
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
                    if (p.id && event.id) {
                      await cancelAppointmentReminder(p.id as string, event.id);
                    }
                    const eventDate = formatDateTimeBR(event.start.dateTime);
                    await sock.sendMessage(remoteJid, { 
                        text: resolveCancelReply(templates, eventDate),
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

        const askingWho =
          Boolean(aiResult.askingProfessionalAvailability) ||
          isAskingProfessionalAvailability(textMessage);

        // Pergunta "qual barbeiro disponível?" → responde quem está livre; NÃO marca.
        if (askingWho && multiBarber) {
          let slotIso: string | null = aiResult.date;
          if (!slotIso && aiResult.extractedDate && aiResult.extractedTime) {
            const parsed = dayjs.tz(
              `${aiResult.extractedDate} ${aiResult.extractedTime}`,
              'YYYY-MM-DD HH:mm',
              'America/Sao_Paulo',
            );
            if (parsed.isValid()) slotIso = parsed.format();
          }
          if (!slotIso && aiResult.extractedTime) {
            const parsed = dayjs.tz(
              `${dayjs().tz('America/Sao_Paulo').format('YYYY-MM-DD')} ${aiResult.extractedTime}`,
              'YYYY-MM-DD HH:mm',
              'America/Sao_Paulo',
            );
            if (parsed.isValid()) slotIso = parsed.format();
          }
          if (!slotIso) {
            const hm =
              textMessage.match(/\b(\d{1,2})\s*:\s*(\d{2})\b/) ||
              textMessage.match(/\b(\d{1,2})\s*h(?:oras?)?\s*(\d{2})?\b/i);
            if (hm) {
              const hour = Number(hm[1]);
              const minute = hm[2] ? Number(hm[2]) : 0;
              const parsed = dayjs()
                .tz('America/Sao_Paulo')
                .hour(hour)
                .minute(minute)
                .second(0)
                .millisecond(0);
              if (parsed.isValid()) slotIso = parsed.format();
            }
          }

          if (slotIso) {
            const free = await listFreeBarbersAtSlot(
              email,
              slotIso,
              p.service_duration ?? 30,
              barberRefs,
            );
            const timeLabel = formatHourCompact(slotIso);
            const reply =
              free.length > 0
                ? `Às ${timeLabel} estão disponíveis: ${free.join(', ')}. Qual prefere?`
                : `Às ${timeLabel} nenhum profissional está livre. Quer outro horário?`;
            log.info(WA, 'resposta de disponibilidade de profissionais', {
              email,
              slotIso,
              free,
            });
            await sock.sendMessage(remoteJid, { text: reply });
            memoryCache[cacheKey].messages.push({ role: 'assistant', content: reply });
            await supabase
              .from('profiles')
              .update({ messages_answered: (p.messages_answered || 0) + 1 })
              .eq('email', email);
            return;
          }

          const teamNames = activeBarbeiros.map((b) => b.nome).join(', ');
          const reply =
            aiResult.response?.trim() ||
            `Temos: ${teamNames}. Qual horário e profissional prefere?`;
          await sock.sendMessage(remoteJid, { text: reply });
          memoryCache[cacheKey].messages.push({ role: 'assistant', content: reply });
          return;
        }

        const pending = memoryCache[cacheKey].scheduling?.pendingConfirmation ?? null;

        // Cliente recusou a proposta pendente.
        if (pending && isNegativeBooking(textMessage)) {
          memoryCache[cacheKey].scheduling!.pendingConfirmation = null;
          const reply = 'Sem problema. Qual outro horário prefere?';
          await sock.sendMessage(remoteJid, { text: reply });
          memoryCache[cacheKey].messages.push({ role: 'assistant', content: reply });
          log.info(WA, 'cliente recusou confirmação pendente', { email });
          return;
        }

        // Só marca no calendário após "sim" explícito sobre a proposta.
        const confirmedByUser = Boolean(pending && isAffirmativeBooking(textMessage));
        const proposedIso = confirmedByUser ? null : aiResult.date;
        const willCreateAppointment = confirmedByUser;

        log.info(WA, 'estado confirmação', {
          email,
          hasPending: !!pending,
          pendingIso: pending?.dateIso ?? null,
          confirmedByUser,
          proposedIso,
          text: textMessage.slice(0, 80),
        });

        // Nova proposta de horário → pede confirmação (nunca marca na hora).
        if (!confirmedByUser && proposedIso && !askingWho) {
          if (multiBarber && !memoryCache[cacheKey].scheduling?.barberConfirmed) {
            log.warn(WA, 'proposta sem profissional — pedindo escolha', { email });
            const teamNames = activeBarbeiros.map((b) => b.nome).join(', ');
            const reply =
              aiResult.response?.trim() ||
              `Qual profissional prefere? ${teamNames}, ou Sem Preferência.`;
            await sock.sendMessage(remoteJid, { text: reply });
            memoryCache[cacheKey].messages.push({ role: 'assistant', content: reply });
            return;
          }

          const sched = memoryCache[cacheKey].scheduling!;
          const pendingBarberName = multiBarber
            ? sched.selectedBarberName
            : activeBarbeiros[0]?.nome ?? null;
          const pendingBarberEmail = multiBarber
            ? sched.selectedBarberEmail
            : activeBarbeiros[0]?.google_calendar_email ?? null;

          memoryCache[cacheKey].scheduling!.pendingConfirmation = {
            dateIso: proposedIso,
            barberName: pendingBarberName,
            barberEmail: pendingBarberEmail,
          };

          const when = formatDateTimeBR(proposedIso);
          const profBit =
            multiBarber && pendingBarberName ? ` com ${pendingBarberName}` : '';
          const reply = `Posso confirmar ${when}${profBit}? Responda *sim* para marcar.`;
          log.info(WA, 'aguardando confirmação do cliente', {
            email,
            proposedIso,
            barber: pendingBarberName,
          });
          await sock.sendMessage(remoteJid, { text: reply });
          memoryCache[cacheKey].messages.push({ role: 'assistant', content: reply });
          await supabase
            .from('profiles')
            .update({ messages_answered: (p.messages_answered || 0) + 1 })
            .eq('email', email);
          return;
        }

        if (aiResult.response && !willCreateAppointment && !proposedIso) {
          try {
              let text = aiResult.response;
              const asksAvailability =
                /horario|horário|disponiv|livre|hoje|amanh/i.test(textMessage) &&
                !isAskingProfessionalAvailability(textMessage);
              const hasUsefulRanges =
                !!freeRangesSummary &&
                !/nenhum horário livre/i.test(freeRangesSummary);

              if (asksAvailability && hasUsefulRanges && !/[–-]/.test(text)) {
                text = `${dayLabel}: ${freeRangesSummary}. Qual horário prefere?`;
              } else if (asksAvailability && !hasUsefulRanges) {
                text = `${dayLabel} não há horários livres. Quer tentar outro dia?`;
              }
              await sock.sendMessage(remoteJid, { text });
              memoryCache[cacheKey].messages.push({ role: 'assistant', content: text });
              
              if (memoryCache[cacheKey].messages.length > MAX_HISTORY) {
                  memoryCache[cacheKey].messages = memoryCache[cacheKey].messages.slice(-MAX_HISTORY);
              }

              await supabase.from('profiles').update({ messages_answered: (p.messages_answered || 0) + 1 }).eq('email', email);
          } catch (sendError) {
              log.error(WA, 'erro ao enviar resposta WhatsApp', sendError, { email, remoteJid });
          }
        }

        // --- 🎯 AGENDAMENTO (só após sim) ---
        if (willCreateAppointment && pending) {
            const bookingIso = pending.dateIso;
            const sched = memoryCache[cacheKey].scheduling!;
            const semPref =
              pending.barberName?.toLowerCase().includes('sem prefer') ?? false;
            const barberName = multiBarber
              ? pending.barberName ?? sched.selectedBarberName ?? 'Sem Preferência'
              : activeBarbeiros.length === 1
                ? activeBarbeiros[0].nome
                : pending.barberName ?? undefined;
            const barberEmail = multiBarber
              ? pending.barberEmail ?? sched.selectedBarberEmail
              : activeBarbeiros.length === 1
                ? activeBarbeiros[0].google_calendar_email
                : pending.barberEmail;

            let finalBarberName = barberName;
            let finalBarberEmail = barberEmail;

            if (semPref && multiBarber) {
              const assigned = await resolveSemPreferenciaBooking(
                email,
                bookingIso,
                p.service_duration ?? 30,
                barberRefs,
              );
              if (!assigned) {
                memoryCache[cacheKey].scheduling!.pendingConfirmation = null;
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
                bookingIso,
                p.service_duration ?? 30,
                {
                  multiBarber,
                  barberName: pending.barberName ?? null,
                  semPreferencia: false,
                  activeBarberNames: activeBarbeiros.map((b) => b.nome),
                },
              );
              if (!isFree) {
                memoryCache[cacheKey].scheduling!.pendingConfirmation = null;
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
                  bookingIso,
                  p.service_duration,
                  { barberName: finalBarberName, barberEmail: finalBarberEmail },
                );

                if (created) {
                    log.info(WA, 'agendamento criado após confirmação', {
                      email,
                      date: bookingIso,
                      dateBR: formatDateTimeBR(bookingIso),
                      barber: finalBarberName,
                      eventId: created.id,
                    });
                    await enqueueAppointmentReminder({
                      profile: {
                        id: p.id as string,
                        email,
                        reminders_enabled: p.reminders_enabled,
                        remind_before_minutes: p.remind_before_minutes,
                        subscription_tier: p.subscription_tier,
                        has_paid: p.has_paid,
                        multi_barber_plan: p.multi_barber_plan as boolean | null | undefined,
                      },
                      googleEventId: created.id,
                      clientPhone,
                      clientName,
                      barberName: finalBarberName,
                      startsAtIso: created.startIso || bookingIso,
                    });
                    memoryCache[cacheKey].scheduling!.pendingConfirmation = null;
                    const confirmDate = formatDateTimeBR(bookingIso);
                    const profLine =
                      multiBarber && finalBarberName
                        ? ` com ${finalBarberName}`
                        : '';
                    const confirmText = resolveAfterBookingReply(
                      templates,
                      `Anotei: ${confirmDate}${profLine}. Te esperamos!`,
                    );
                    await sock.sendMessage(remoteJid, { text: confirmText });
                    memoryCache[cacheKey].messages.push({ role: 'assistant', content: confirmText });
                    await supabase.from('profiles').update({
                        messages_answered: (p.messages_answered || 0) + 1,
                        appointments_made: (p.appointments_made || 0) + 1,
                        appointments_count: (p.appointments_count || 0) + 1,
                    }).eq('email', email);
                    delete memoryCache[cacheKey];
                } else if (aiResult.response) {
                    await sock.sendMessage(remoteJid, { text: aiResult.response });
                }
            }
        }
      } catch (err) {
        log.error(WA, 'Erro no fluxo da IA / mensagem', err, { email });
      }
      finally {
        finishMessageProcessing(dedupeKey);
      }
    });
  } catch (error) {
    log.error(WA, 'Erro startWhatsApp', error, { email });
    pairingRestartByEmail.delete(email);
    if (isBaileysCryptoError(error)) {
      await purgeWhatsAppSession(email, 'falha ao iniciar com credenciais inválidas');
    }
    if (res && !res.headersSent) {
      res.status(500).json({ error: 'Falha ao iniciar WhatsApp. Veja os logs do Render.' });
    }
  } finally {
    startInFlightByEmail.delete(email);
  }
}

export async function autoReconnectAll() {
  log.step(WA, 'autoReconnectAll iniciado');
  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('email, has_paid, complimentary_access_until, is_ai_enabled')
    .eq('is_ai_enabled', true);

  if (error) {
    log.error(WA, 'autoReconnectAll — falha ao listar profiles', error);
    return;
  }

  const eligible = (profiles ?? []).filter((p) =>
    profileHasWagooAccess(p as { has_paid?: boolean; complimentary_access_until?: string | null }),
  );

  log.info(WA, 'autoReconnectAll elegíveis', { total: eligible.length });

  for (const p of eligible) {
    try {
      await startWhatsApp(p.email, null);
    } catch (err) {
      log.error(WA, 'autoReconnect falhou', err, { email: p.email });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  log.step(WA, 'autoReconnectAll concluído');
}
