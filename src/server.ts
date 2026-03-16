import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import qrcode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

// Nossos módulos
import { analyzeMessage } from './services/ai';
import { checkAvailability, createEvent } from './services/calendar';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// ==========================================
// CONFIGURAÇÃO DO CORS
// ==========================================
app.use(cors({
  origin: [
    'https://wagbot.vercel.app', 
    'https://wag-frontend-korvenlabcontato-4447s-projects.vercel.app',
    'http://localhost:5173', 
    'http://localhost:3000' 
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ [ERRO FATAL] Chaves do Supabase não encontradas no arquivo .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const sessions: Record<string, ReturnType<typeof makeWASocket>> = {};

// ==========================================
// FUNÇÃO PRINCIPAL: Iniciar WhatsApp
// ==========================================
async function startWhatsApp(email: string, res: Response | null) {
  try {
    const baseAuthDir = path.join(__dirname, '..', 'auth_info_baileys');
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
          startWhatsApp(email, null);
        } else {
          if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
          delete sessions[email];
        }
      } else if (connection === 'open') {
        if (res && !res.headersSent && !qrSent) res.status(200).json({ message: 'Sessão conectada.' });
      }
    });

    // ========================================================
    // INTEGRAÇÃO: OUVIR, PENSAR (AI) E AGENDAR
    // ========================================================
    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!textMessage) return;

      const remoteJid = msg.key.remoteJid; 
      console.log(`💬 [BOT] Mensagem de ${remoteJid}: "${textMessage}"`);

      try {
        const { data: profile, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('email', email)
          .single();

        if (error || !profile || !profile.is_ai_enabled) return;

        const dbRow = {
          store_name: profile.store_name || 'Nossa Loja',
          start_time: profile.start_time || '08:00',
          end_time: profile.end_time || '18:00',
          active_days: profile.active_days || '[]'
        };

        const history = ""; 

        const aiResult = await analyzeMessage(history, textMessage, profile.is_ai_enabled, dbRow);

        if (!aiResult.isScheduling && aiResult.response && remoteJid) {
          await sock.sendMessage(remoteJid, { text: aiResult.response });
          const novasMensagens = (profile.messages_answered || 0) + 1;
          await supabase.from('profiles').update({ messages_answered: novasMensagens }).eq('email', email);
        }

        if (aiResult.isScheduling && aiResult.date && remoteJid) {
           console.log(`📅 Verificando disponibilidade para: ${aiResult.date}`);
           const isAvailable = await checkAvailability(profile.id, aiResult.date);

           if (isAvailable) {
               const clientName = msg.pushName || "Cliente WhatsApp";
               const clientPhone = remoteJid.split('@')[0];
               const success = await createEvent(profile.id, clientName, clientPhone, aiResult.date);
               
               if (success) {
                   const msgSucesso = aiResult.response || `✅ Agendamento confirmado para ${aiResult.date}!`;
                   await sock.sendMessage(remoteJid, { text: msgSucesso });
                   const novosAgendamentos = (profile.appointments_made || 0) + 1;
                   await supabase.from('profiles').update({ appointments_made: novosAgendamentos }).eq('email', email);
               } else {
                   await sock.sendMessage(remoteJid, { text: "❌ Erro técnico ao salvar na agenda." });
               }
           } else {
               await sock.sendMessage(remoteJid, { text: "⚠️ Esse horário já está ocupado. Poderia escolher outro?" });
           }
        }
      } catch (err) {
        console.error(`❌ Erro no fluxo:`, err);
      }
    });

  } catch (error) {
    console.error('🔥 Erro ao iniciar WhatsApp:', error);
  }
}

// ==========================================
// ROTAS DA API
// ==========================================

// Rota de Ping para Keep-Alive (Sem Log)
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

app.post('/api/whatsapp/qr', async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });

  const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
  const sessionDir = path.join(__dirname, '..', 'auth_info_baileys', safeEmailFolder);

  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
  if (sessions[email]) { sessions[email].ws.close(); delete sessions[email]; }

  startWhatsApp(email, res);
});

app.post('/api/whatsapp/disconnect', async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });
  if (sessions[email]) { sessions[email].ws.close(); delete sessions[email]; }
  const sessionDir = path.join(__dirname, '..', 'auth_info_baileys', email.replace(/[^a-zA-Z0-9]/g, '_'));
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
  res.status(200).json({ message: 'Desconectado.' });
});

app.post('/api/settings/ai', async (req: Request, res: Response) => {
  const { email, aiEnabled } = req.body;
  await supabase.from('profiles').update({ is_ai_enabled: aiEnabled }).eq('email', email);
  res.status(200).json({ message: 'OK' });
});

app.get('/api/user/profile', async (req: Request, res: Response) => {
  const email = req.query.email as string;
  const { data } = await supabase.from('profiles').select('*').eq('email', email).single();
  res.status(200).json(data);
});

app.post('/api/settings/hours', async (req: Request, res: Response) => {
  const { email, startTime, endTime, activeDays, serviceDuration } = req.body;
  await supabase.from('profiles').update({ 
    start_time: startTime,
    end_time: endTime,
    active_days: activeDays,
    service_duration: serviceDuration
  }).eq('email', email);
  res.status(200).json({ message: 'Salvo!' });
});

app.get('/', (req, res) => res.send('WBOT Online!'));

// ==========================================
// CONFIGURAÇÃO DE INICIALIZAÇÃO E AUTO-PING
// ==========================================
app.listen(port, () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
  
  // Auto-ping interno a cada 14 minutos para evitar suspensão na Render
  const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
  
  setInterval(() => {
    fetch(`${RENDER_EXTERNAL_URL}/ping`).catch(() => {
        // Silencioso conforme solicitado
    });
  }, 840000); // 14 minutos
  
  console.log(`📡 Sistema de Auto-ping iniciado para: ${RENDER_EXTERNAL_URL}/ping`);
});
