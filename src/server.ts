import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import qrcode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
  origin: [
    'https://wag-frontend-korvenlabcontato-4447s-projects.vercel.app', 
    'http://localhost:5173', 
    'http://localhost:3000' 
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("ERRO FATAL: Chaves do Supabase não encontradas no arquivo .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const sessions: Record<string, ReturnType<typeof makeWASocket>> = {};

// ==========================================
// ROTA: Geração de QR Code e Motor do Bot
// ==========================================
app.post('/api/whatsapp/qr', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;

  if (!email) {
    res.status(400).json({ error: 'Email é obrigatório para gerar o QR Code.' });
    return;
  }

  try {
    const baseAuthDir = path.join(__dirname, '..', 'auth_info_baileys');
    if (!fs.existsSync(baseAuthDir)) {
      fs.mkdirSync(baseAuthDir, { recursive: true });
    }

    const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
    const sessionDir = path.join(baseAuthDir, safeEmailFolder);

    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    if (sessions[email]) {
      sessions[email].ws.close();
      delete sessions[email];
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }), 
      browser: ['Ubuntu', 'Chrome', '20.0.04'], 
      syncFullHistory: false, 
      generateHighQualityLinkPreview: false
    });

    sessions[email] = sock;
    sock.ev.on('creds.update', saveCreds);

    let qrSent = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !qrSent) {
        try {
          qrSent = true;
          const qrCodeImage = await qrcode.toDataURL(qr);
          if (!res.headersSent) {
            res.status(200).json({ qrCode: qrCodeImage });
          }
        } catch (err) {
          console.error('Erro ao converter QR Code:', err);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Falha ao processar o QR Code' });
          }
        }
      }

      if (connection === 'close') {
        const boomError = lastDisconnect?.error as Boom;
        const statusCode = boomError?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        if (!shouldReconnect && !qrSent && !res.headersSent) {
           res.status(500).json({ error: 'A conexão falhou permanentemente. Tente novamente.' });
        }
        
      } else if (connection === 'open') {
        console.log(`WhatsApp conectado com sucesso para: ${email}`);
        if (!qrSent && !res.headersSent) {
           res.status(200).json({ message: 'Sessão conectada.' });
        }
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      console.log(`Nova mensagem recebida no bot de ${email}`);

      const { data: profile } = await supabase
        .from('profiles')
        .select('is_ai_enabled, messages_answered')
        .eq('email', email)
        .single();

      if (profile?.is_ai_enabled) {
        const novasMensagens = (profile.messages_answered || 0) + 1;
        await supabase
          .from('profiles')
          .update({ messages_answered: novasMensagens })
          .eq('email', email);
          
        console.log(`Métrica atualizada para ${email}: ${novasMensagens} mensagens.`);
      }
    });

  } catch (criticalError) {
    console.error('ERRO CRÍTICO na rota de QR Code:', criticalError);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro interno no servidor ao tentar conectar ao WhatsApp.' });
    }
  }
});

// ==========================================
// ROTA: Desconectar WhatsApp
// ==========================================
app.post('/api/whatsapp/disconnect', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;
  if (!email) {
    res.status(400).end();
    return;
  }

  try {
    if (sessions[email]) {
      sessions[email].ws.close();
      delete sessions[email];
    }
    const sessionDir = path.join(__dirname, '..', 'auth_info_baileys', email.replace(/[^a-zA-Z0-9]/g, '_'));
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    
    res.status(200).json({ message: 'Desconectado.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao desconectar.' });
  }
});

// ==========================================
// ROTA: Ligar/Desligar IA
// ==========================================
app.post('/api/settings/ai', async (req: Request, res: Response): Promise<void> => {
  const { email, aiEnabled } = req.body;
  if (!email) {
    res.status(400).end();
    return;
  }

  try {
    await supabase.from('profiles').update({ is_ai_enabled: aiEnabled }).eq('email', email);
    res.status(200).json({ message: 'Configuração atualizada!' });
  } catch (error) {
    res.status(500).json({ error: 'Falha.' });
  }
});

// ==========================================
// NOVAS ROTAS PARA O DASHBOARD FRONTEND
// ==========================================

app.get('/api/user/profile', async (req: Request, res: Response): Promise<void> => {
  const email = req.query.email as string;
  if (!email) {
    res.status(400).json({ error: 'Email não fornecido.' });
    return;
  }

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('email', email)
      .single();

    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar perfil.' });
  }
});

app.post('/api/settings/store', async (req: Request, res: Response): Promise<void> => {
  const { email, storeName } = req.body;
  if (!email) {
    res.status(400).end();
    return;
  }

  try {
    await supabase.from('profiles').update({ store_name: storeName }).eq('email', email);
    res.status(200).json({ message: 'Nome salvo com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao salvar.' });
  }
});

app.post('/api/settings/hours', async (req: Request, res: Response): Promise<void> => {
  const { email, startTime, endTime, activeDays, serviceDuration } = req.body;
  if (!email) {
    res.status(400).end();
    return;
  }

  try {
    await supabase.from('profiles').update({ 
      start_time: startTime,
      end_time: endTime,
      active_days: activeDays,
      service_duration: serviceDuration
    }).eq('email', email);
    
    res.status(200).json({ message: 'Horários salvos com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao salvar horários.' });
  }
});

app.get('/', (req: Request, res: Response) => {
  res.send('API do WAG BOT operando normalmente!');
});

app.listen(port, () => {
  console.log(`🚀 Backend rodando na porta ${port}`);
});
