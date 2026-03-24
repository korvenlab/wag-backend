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
import { createClient } from '@supabase/supabase-js';

import { analyzeMessage, hasSchedulingIntent } from './ai';
import { checkAvailability, createEvent, getBusySlots, findEventByPhone, deleteEvent } from './calendar';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
export const sessions: Record<string, any> = {};

/**
 * 🧠 MEMÓRIA RAM VOLÁTIL (SaaS Ready)
 * Configurada para 10h de inatividade e histórico de 7 trocas completas.
 */
interface ChatContext {
  lastUpdate: number;
  messages: { role: 'user' | 'assistant', content: string }[];
}

const memoryCache: Record<string, ChatContext> = {};
const SESSION_EXPIRATION = 10 * 60 * 60 * 1000; // 10 Horas
const MAX_HISTORY = 14; // Garante as últimas 7 mensagens do cliente + 7 da Lucy

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
          if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
        } else {
          setTimeout(() => startWhatsApp(email, null), 5000);
        }
      } else if (connection === 'open') {
        console.log(`✅ [ATIVO] Bot online para: ${email}`);
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
        if (!p || !p.has_paid || !p.is_ai_enabled) return;

        // --- 🚪 PORTÃO DE ENTRADA & ATIVAÇÃO INTELIGENTE ---
        const sessionExists = !!memoryCache[cacheKey];
        const isExpired = sessionExists && (now - memoryCache[cacheKey].lastUpdate > SESSION_EXPIRATION);
        const activeSession = sessionExists && !isExpired;

        // FEATURE: Ignora "Oi" sem intenção se não houver atendimento ativo para economizar API
        if (!activeSession && !hasSchedulingIntent(textMessage)) {
            return; 
        }

        // --- 🧠 GESTÃO DE MEMÓRIA ---
        if (!activeSession) {
            console.log(`🎯 [ATIVADO] Intenção detectada para ${cacheKey}.`);
            memoryCache[cacheKey] = { lastUpdate: now, messages: [] };
        }

        memoryCache[cacheKey].lastUpdate = now;
        memoryCache[cacheKey].messages.push({ role: 'user', content: textMessage });

        const currentHistory = memoryCache[cacheKey].messages.slice(-MAX_HISTORY);
        const formattedHistory = currentHistory
            .map(h => `${h.role === 'user' ? 'Cliente' : 'Lucy'}: ${h.content}`)
            .join('\n');

        const busySlots = await getBusySlots(email, new Date().toISOString());

        const aiResult = await analyzeMessage(formattedHistory, textMessage, true, false, busySlots, {
            store_name: p.store_name,
            working_hours: p.working_hours,
            service_duration: p.service_duration
        });

        // --- 🗑️ LÓGICA DE CANCELAMENTO REAL (GOOGLE CALENDAR) ---
        if (aiResult.isCancelling) {
            const clientPhone = remoteJid.split('@')[0];
            const event = await findEventByPhone(email, clientPhone);

            if (event) {
                const success = await deleteEvent(email, event.id);
                if (success) {
                    const eventDate = new Date(event.start.dateTime).toLocaleString('pt-BR');
                    await sock.sendMessage(remoteJid, { 
                        text: `Perfeito. Localizei seu agendamento para ${eventDate} e ele já foi cancelado conforme solicitado.` 
                    });
                    console.log(`🗑️ Resetando memória após cancelamento: ${cacheKey}`);
                    delete memoryCache[cacheKey]; // Mata a memória após concluir a missão
                    return;
                }
            } else {
                await sock.sendMessage(remoteJid, { 
                    text: "Não encontrei nenhum agendamento futuro vinculado ao seu número para realizar o cancelamento automático." 
                });
                return;
            }
        }

        // --- 💬 RESPOSTA DA IA ---
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

        // --- 🎯 FINALIZAÇÃO PÓS-AGENDAMENTO ---
        if (aiResult.isScheduling && aiResult.date) {
            const isFree = await checkAvailability(email, aiResult.date, p.service_duration);
            if (isFree) {
                // FEATURE: Prioriza o nome capturado pela IA no chat
                const clientName = aiResult.clientName || msg.pushName || "Cliente WhatsApp";
                const clientPhone = remoteJid.split('@')[0];
                const created = await createEvent(email, clientName, clientPhone, aiResult.date, p.service_duration);
                
                if (created) {
                    await supabase.from('profiles').update({ 
                        appointments_count: (p.appointments_count || 0) + 1 
                    }).eq('email', email);

                    console.log(`✅ Agendamento concluído. Resetando memória de ${cacheKey}.`);
                    delete memoryCache[cacheKey]; // Limpa a memória para não responder "Obrigado"
                }
            }
        }
      } catch (err) { console.error("Erro Lucy:", err); }
    });
  } catch (error) { console.error('Erro startWhatsApp:', error); }
}

export async function autoReconnectAll() {
  const { data: profiles } = await supabase.from('profiles').select('email').eq('has_paid', true).eq('is_ai_enabled', true);
  if (profiles) profiles.forEach(p => startWhatsApp(p.email, null));
}
