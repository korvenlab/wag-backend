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
import { checkAvailability, createEvent } from './calendar';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
export const sessions: Record<string, any> = {};

export async function startWhatsApp(email: string, res: Response | null) {
  try {
    const baseAuthDir = path.join(__dirname, '..', '..', 'auth_info_baileys');
    const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
    const sessionDir = path.join(baseAuthDir, safeEmailFolder);

    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    // --- LOGICA DE RESTAURAÇÃO DO SUPABASE ---
    const { data: profile } = await supabase
      .from('profiles')
      .select('whatsapp_session')
      .eq('email', email)
      .single();

    const credsFilePath = path.join(sessionDir, 'creds.json');

    // Se a pasta está vazia mas temos a sessão no banco, restauramos o arquivo
    if (!fs.existsSync(credsFilePath) && profile?.whatsapp_session) {
      console.log(`📥 [Supabase] Restaurando credenciais para: ${email}`);
      fs.writeFileSync(credsFilePath, JSON.stringify(profile.whatsapp_session));
    }
    // ------------------------------------------

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

    // EVENTO CRUCIAL: Salva no banco sempre que houver mudança
    sock.ev.on('creds.update', async () => {
      await saveCreds();
      
      // Lemos o que o Baileys salvou no disco e mandamos para o Supabase
      if (fs.existsSync(credsFilePath)) {
        const credsData = JSON.parse(fs.readFileSync(credsFilePath, 'utf-8'));
        await supabase
          .from('profiles')
          .update({ whatsapp_session: credsData })
          .eq('email', email);
        console.log(`☁️ [Supabase] Sessão sincronizada via nuvem: ${email}`);
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
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        if (shouldReconnect) {
          startWhatsApp(email, null);
        } else {
          // Se o usuário deslogou, limpamos o banco também
          await supabase.from('profiles').update({ whatsapp_session: null }).eq('email', email);
          if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
          delete sessions[email];
        }
      } else if (connection === 'open') {
        console.log(`✅ [ATIVO] Bot online para: ${email}`);
        if (res && !res.headersSent) res.status(200).json({ message: 'Conectado!' });
      }
    });

    // Lógica da Lucy (Mensagens)
    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!textMessage) return;

      const remoteJid = msg.key.remoteJid;

      try {
        const { data: p } = await supabase.from('profiles').select('*').eq('email', email).single();
        if (!p || !p.has_paid || !p.is_ai_enabled) return;

        const aiResult = await analyzeMessage("", textMessage, true, p);

        if (!aiResult.isScheduling && aiResult.response && remoteJid) {
          await sock.sendMessage(remoteJid, { text: aiResult.response });
          await supabase.from('profiles').update({ messages_answered: (p.messages_answered || 0) + 1 }).eq('email', email);
        }
        
        // ... (Agendamento)
      } catch (err) { console.error(err); }
    });

  } catch (error) {
    console.error('Erro no startWhatsApp:', error);
  }
}

// Reconecta automaticamente ao ligar o servidor
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
