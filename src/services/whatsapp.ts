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

import { analyzeMessage } from './ai';
import { checkAvailability, createEvent, getBusySlots } from './calendar';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
export const sessions: Record<string, any> = {};

export async function disconnectWhatsApp(email: string) {
  try {
    const sock = sessions[email];
    const baseAuthDir = path.join(__dirname, '..', '..', 'auth_info_baileys');
    const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
    const sessionDir = path.join(baseAuthDir, safeEmailFolder);

    if (sock) {
      sock.ev.removeAllListeners(); // FEATURE: Limpeza total de eventos para não deixar rastos
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
    // 🛑 FEATURE: O MATA-ZUMBIS (Evita o loop de bots duplicados na memória)
    if (sessions[email]) {
        console.log(`🧹 Limpando processo antigo do bot para: ${email}`);
        sessions[email].ev.removeAllListeners(); // Para de ouvir mensagens e eventos antigos
        try { sessions[email].ws.close(); } catch(e) {} // Força a desconexão bruta do socket antigo
        delete sessions[email]; // Liberta a memória RAM
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
      console.log(`📥 [Supabase] Restaurando credenciais para: ${email}`);
      fs.writeFileSync(credsFilePath, JSON.stringify(profile.whatsapp_session));
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }), // Continua silencioso para não poluir
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: true,
      // FEATURE: Tempos de espera ajustados para o bot ser mais tolerante a quedas curtas de internet
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
        console.error(`⚠️ Erro ao processar credenciais de ${email}:`, parseError);
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
        console.log(`⚠️ Conexão fechada para ${email}. Código de erro: ${statusCode}`);
        
        // Limpamos os listeners do socket que acabou de cair para que ele não dispare duplamente
        if (sessions[email]) {
            sessions[email].ev.removeAllListeners();
            delete sessions[email];
        }

        if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 440 || statusCode === 403) {
          console.log(`🛑 Erro fatal (${statusCode}). Limpando sessão e abortando reconexão para: ${email}`);
          
          await supabase.from('profiles').update({ whatsapp_session: null }).eq('email', email);
          if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
          
          console.log(`🧹 Sessão corrompida destruída. O utilizador deve ler um novo QR Code.`);
        } 
        else {
          console.log(`🔄 Agendando reconexão para ${email} em 5 segundos...`);
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
      if (!remoteJid) return;

      const isGroup = remoteJid.endsWith('@g.us');
      if (isGroup) return;

      const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!textMessage) return;

      try {
        const { data: p } = await supabase.from('profiles').select('*').eq('email', email).single();
        if (!p || !p.has_paid || !p.is_ai_enabled) return;

        const busySlots = await getBusySlots(email, new Date().toISOString());

        const aiResult = await analyzeMessage("", textMessage, true, isGroup, busySlots, {
            store_name: p.store_name,
            working_hours: p.working_hours,
            service_duration: p.service_duration
        });

        if (aiResult.response) {
          // FEATURE: Escudo contra o erro de crash (Error 428: Connection Closed)
          try {
              await sock.sendMessage(remoteJid, { text: aiResult.response });
              await supabase.from('profiles').update({ messages_answered: (p.messages_answered || 0) + 1 }).eq('email', email);
          } catch (sendError) {
              console.error(`❌ Não foi possível enviar a mensagem para ${remoteJid} (O socket já estava fechado)`);
          }
        }

        if (aiResult.isScheduling && aiResult.date) {
            const isFree = await checkAvailability(email, aiResult.date, p.service_duration);
            if (isFree) {
                const clientName = msg.pushName || "Cliente WhatsApp";
                const clientPhone = remoteJid.split('@')[0];
                const created = await createEvent(email, clientName, clientPhone, aiResult.date, p.service_duration);
                if (created) {
                    await supabase.from('profiles').update({ 
                        appointments_count: (p.appointments_count || 0) + 1 
                    }).eq('email', email);
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
