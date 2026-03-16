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

/**
 * Função para desconectar o WhatsApp (Chamada pela rota API)
 */
export async function disconnectWhatsApp(email: string) {
  try {
    const sock = sessions[email];
    const baseAuthDir = path.join(__dirname, '..', '..', 'auth_info_baileys');
    const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
    const sessionDir = path.join(baseAuthDir, safeEmailFolder);

    if (sock) {
      // 1. Desconecta do servidor do WhatsApp
      await sock.logout();
      // 2. Remove da memória
      delete sessions[email];
    }

    // 3. Limpa os arquivos de autenticação locais
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    // 4. Limpa no banco de dados Supabase
    await supabase.from('profiles').update({ whatsapp_session: null }).eq('email', email);

    console.log(`\x1b[31m[OFFLINE]\x1b[0m Sessão encerrada e limpa para: ${email}`);
    return { success: true };
  } catch (error) {
    console.error('Erro ao desconectar WhatsApp:', error);
    throw error;
  }
}

export async function startWhatsApp(email: string, res: Response | null) {
  try {
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
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: true
    });

    sessions[email] = sock;

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      if (fs.existsSync(credsFilePath)) {
        const credsData = JSON.parse(fs.readFileSync(credsFilePath, 'utf-8'));
        await supabase.from('profiles').update({ whatsapp_session: credsData }).eq('email', email);
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
        
        // Só reconecta se NÃO for um logout intencional
        if (statusCode !== DisconnectReason.loggedOut) {
          startWhatsApp(email, null);
        } else {
          await supabase.from('profiles').update({ whatsapp_session: null }).eq('email', email);
          if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
          delete sessions[email];
        }
      } else if (connection === 'open') {
        console.log(`✅ [ATIVO] Bot online para: ${email}`);
        if (res && !res.headersSent) res.status(200).json({ message: 'Conectado!' });
      }
    });

    // Lógica da Lucy (Mensagens e Agendamento)
    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!textMessage) return;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid) return;

      try {
        const { data: p } = await supabase.from('profiles').select('*').eq('email', email).single();
        if (!p || !p.has_paid || !p.is_ai_enabled) return;

        const busySlots = await getBusySlots(p.id, new Date().toISOString());

        const aiResult = await analyzeMessage("", textMessage, true, busySlots, {
            store_name: p.store_name,
            working_hours: p.working_hours,
            service_duration: p.service_duration
        });

        if (aiResult.response) {
          await sock.sendMessage(remoteJid, { text: aiResult.response });
          await supabase.from('profiles').update({ messages_answered: (p.messages_answered || 0) + 1 }).eq('email', email);
        }

        if (aiResult.isScheduling && aiResult.date) {
            const isFree = await checkAvailability(p.id, aiResult.date, p.service_duration);
            
            if (isFree) {
                const clientName = msg.pushName || "Cliente WhatsApp";
                const clientPhone = remoteJid.split('@')[0];
                
                const created = await createEvent(p.id, clientName, clientPhone, aiResult.date, p.service_duration);
                
                if (created) {
                    console.log(`📅 Agendamento realizado: ${clientName} em ${aiResult.date}`);
                    await supabase.from('profiles').update({ 
                        appointments_count: (p.appointments_count || 0) + 1 
                    }).eq('email', email);
                }
            }
        }
        
      } catch (err) { 
        console.error("Erro no processamento da Lucy:", err); 
      }
    });

  } catch (error) {
    console.error('Erro no startWhatsApp:', error);
  }
}

export async function autoReconnectAll() {
  const { data: profiles } = await supabase
    .from('profiles')
    .select('email')
    .eq('has_paid', true)
    .eq('is_ai_enabled', true);

  if (profiles) {
    profiles.forEach(p => startWhatsApp(p.email, null));
  }
}
