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

// Módulos internos
import { analyzeMessage } from './ai';
import { checkAvailability, createEvent } from './calendar';

// Inicialização do Supabase Service Role (necessário para bypass de RLS se houver)
const supabase = createClient(
  process.env.SUPABASE_URL!, 
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const sessions: Record<string, any> = {};

/**
 * Inicia a conexão do WhatsApp para um email específico
 */
export async function startWhatsApp(email: string, res: Response | null) {
  try {
    // Ajuste de caminho: sobe dois níveis para sair de src/services e chegar na raiz
    const baseAuthDir = path.join(__dirname, '..', '..', 'auth_info_baileys');
    if (!fs.existsSync(baseAuthDir)) fs.mkdirSync(baseAuthDir, { recursive: true });

    const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
    const sessionDir = path.join(baseAuthDir, safeEmailFolder);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: false,
      markOnlineOnConnect: true
    });

    sessions[email] = sock;
    sock.ev.on('creds.update', saveCreds);

    let qrSent = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Envio de QR Code para o frontend
      if (qr && res && !qrSent) {
        try {
          qrSent = true;
          const qrCodeImage = await qrcode.toDataURL(qr);
          if (!res.headersSent) res.status(200).json({ qrCode: qrCodeImage });
        } catch (err) {
          if (!res.headersSent) res.status(500).json({ error: 'Falha ao processar o QR Code' });
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        if (shouldReconnect) {
          console.log(`🔄 [RECONECTANDO] Sessão: ${email}`);
          startWhatsApp(email, null);
        } else {
          console.log(`🚫 [DESCONECTADO] Limpando dados de: ${email}`);
          if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
          delete sessions[email];
        }
      } else if (connection === 'open') {
        console.log(`✅ [CONECTADO] WhatsApp pronto para: ${email}`);
        if (res && !res.headersSent && !qrSent) res.status(200).json({ message: 'Sessão conectada.' });
      }
    });

    // Lógica de Mensagens Recebidas
    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!textMessage) return;

      const remoteJid = msg.key.remoteJid;

      try {
        // Busca o perfil no Supabase para validar acesso
        const { data: profile, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('email', email)
          .single();

        // VALIDAÇÃO: Só responde se pagou E se a IA estiver ligada no botão
        if (error || !profile || !profile.has_paid || !profile.is_ai_enabled) return;

        const dbRow = {
          store_name: profile.store_name || 'Nossa Loja',
          start_time: profile.start_time || '08:00',
          end_time: profile.end_time || '18:00',
          active_days: profile.active_days || '[]'
        };

        // Chama a IA (Lucy)
        const aiResult = await analyzeMessage("", textMessage, profile.is_ai_enabled, dbRow);

        // Caso seja apenas resposta de texto
        if (!aiResult.isScheduling && aiResult.response && remoteJid) {
          await sock.sendMessage(remoteJid, { text: aiResult.response });
          
          // Incrementa contador de mensagens
          await supabase.from('profiles').update({ 
            messages_answered: (profile.messages_answered || 0) + 1 
          }).eq('email', email);
        }

        // Caso seja intenção de agendamento
        if (aiResult.isScheduling && aiResult.date && remoteJid) {
          const isAvailable = await checkAvailability(profile.id, aiResult.date);

          if (isAvailable) {
            const clientName = msg.pushName || "Cliente WhatsApp";
            const clientPhone = remoteJid.split('@')[0];
            const success = await createEvent(profile.id, clientName, clientPhone, aiResult.date);
            
            if (success) {
              await sock.sendMessage(remoteJid, { text: aiResult.response || `✅ Confirmado para ${aiResult.date}!` });
              await supabase.from('profiles').update({ 
                appointments_made: (profile.appointments_made || 0) + 1 
              }).eq('email', email);
            }
          } else {
            await sock.sendMessage(remoteJid, { text: "⚠️ Desculpe, esse horário acabou de ser preenchido. Pode escolher outro?" });
          }
        }
      } catch (err) {
        console.error(`❌ Erro no fluxo de mensagem (${email}):`, err);
      }
    });

  } catch (error) {
    console.error(`🔥 Erro fatal no serviço WhatsApp (${email}):`, error);
  }
}

/**
 * Percorre o banco de dados e reconecta todos os usuários ativos
 */
export async function autoReconnectAll() {
  console.log("🔍 [AUTO-RECONNECT] Iniciando varredura de usuários ativos...");

  try {
    const { data: activeProfiles, error } = await supabase
      .from('profiles')
      .select('email')
      .eq('has_paid', true)
      .eq('is_ai_enabled', true);

    if (error) {
      console.error("❌ Erro ao buscar perfis para reconexão:", error.message);
      return;
    }

    if (!activeProfiles || activeProfiles.length === 0) {
      console.log("ℹ️ Nenhum usuário ativo para reconectar.");
      return;
    }

    console.log(`🚀 Tentando reconectar ${activeProfiles.length} usuário(s)...`);

    activeProfiles.forEach(profile => {
      // Inicia o socket em background (res é null aqui)
      startWhatsApp(profile.email, null);
    });

  } catch (err) {
    console.error("🔥 Erro na função autoReconnectAll:", err);
  }
}