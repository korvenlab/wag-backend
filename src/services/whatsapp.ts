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
      await sock.logout();
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

    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      
      // 1. Validações básicas e prevenção de auto-resposta
      if (!msg.message || msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid) return;

      // 2. BLOQUEIO DE GRUPOS: Se o ID contiver '@g.us', interrompe na hora.
      const isGroup = remoteJid.endsWith('@g.us');
      if (isGroup) return;

      const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!textMessage) return;

      try {
        const { data: p } = await supabase.from('profiles').select('*').eq('email', email).single();
        if (!p || !p.has_paid || !p.is_ai_enabled) return;

        const busySlots = await getBusySlots(p.id, new Date().toISOString());

        // 3. Chamada para a IA passando o parâmetro isGroup (falso aqui devido ao filtro acima)
        const aiResult = await analyzeMessage("", textMessage, true, isGroup, busySlots, {
            store_name: p.store_name,
            working_hours: p.working_hours,
            service_duration: p.service_duration
        });

        // Só envia se a IA retornou uma resposta (o filtro de palavras-chave está dentro da analyzeMessage)
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
