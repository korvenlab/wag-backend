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

// Memória do servidor para guardar as conexões ativas
const sessions: Record<string, ReturnType<typeof makeWASocket>> = {};

// ==========================================
// FUNÇÃO PRINCIPAL: Iniciar e Reconectar WhatsApp
// ==========================================
async function startWhatsApp(email: string, res: Response | null) {
  try {
    const baseAuthDir = path.join(__dirname, '..', 'auth_info_baileys');
    if (!fs.existsSync(baseAuthDir)) {
      fs.mkdirSync(baseAuthDir, { recursive: true });
    }

    const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
    const sessionDir = path.join(baseAuthDir, safeEmailFolder);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`🚀 [WHATSAPP] Inicializando motor para ${email}...`);
    
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }), 
      browser: Browsers.macOS('Desktop'), 
      syncFullHistory: false, 
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: true, 
      connectTimeoutMs: 60000, 
      keepAliveIntervalMs: 10000 
    });

    sessions[email] = sock;
    
    // Ouve as mudanças de chaves e salva-as (Crucial para o erro 515)
    sock.ev.on('creds.update', () => {
      saveCreds();
    });

    let qrSent = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Se existir um QR Code e nós tivermos o objeto "res" do frontend disponível
      if (qr && res && !qrSent) {
        console.log(`📸 [WHATSAPP] Novo QR Code gerado! Enviando ao frontend...`);
        try {
          qrSent = true;
          const qrCodeImage = await qrcode.toDataURL(qr);
          if (!res.headersSent) {
            res.status(200).json({ qrCode: qrCodeImage });
          }
        } catch (err) {
          console.error('❌ [ERRO] Falha ao converter QR Code:', err);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Falha ao processar o QR Code' });
          }
        }
      }

      // GERENCIAMENTO DE QUEDAS E RECONEXÃO (A SOLUÇÃO DO ERRO 515)
      if (connection === 'close') {
        const boomError = lastDisconnect?.error as Boom;
        const statusCode = boomError?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`⚠️ [WHATSAPP] Conexão FECHADA para ${email}. Status: ${statusCode}.`);

        if (shouldReconnect) {
          console.log(`🔄 [WHATSAPP] Meta solicitou reinício. Executando reconexão automática para ${email}...`);
          // Chamada RECURSIVA: O servidor liga para a função de novo, mas passa "null" no "res" 
          // para não quebrar a resposta HTTP do express que já foi enviada.
          startWhatsApp(email, null);
        } else {
          console.log(`🛑 [WHATSAPP] Sessão desconectada permanentemente (Logged Out).`);
          if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
          }
          delete sessions[email];
          
          if (res && !res.headersSent && !qrSent) {
             res.status(500).json({ error: 'A conexão falhou permanentemente.' });
          }
        }
        
      } else if (connection === 'open') {
        console.log(`🎉 [WHATSAPP] SUCESSO! Aparelho de ${email} conectado perfeitamente.`);
        if (res && !res.headersSent && !qrSent) {
           res.status(200).json({ message: 'Sessão conectada.' });
        }
      }
    });

    // ========================================================
    // OUVINTE DE MENSAGENS E MÉTRICAS DA IA
    // ========================================================
    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      console.log(`\n💬 [BOT] Nova mensagem recebida no número de ${email}`);

      try {
        const { data: profile, error } = await supabase
          .from('profiles')
          .select('is_ai_enabled, messages_answered')
          .eq('email', email)
          .single();

        if (error) return;

        if (profile?.is_ai_enabled) {
          const novasMensagens = (profile.messages_answered || 0) + 1;
          await supabase
            .from('profiles')
            .update({ messages_answered: novasMensagens })
            .eq('email', email);
            
          console.log(`📈 [MÉTRICAS] Contador atualizado: ${novasMensagens} mensagens.`);
        }
      } catch (dbError) {
        console.error(`❌ [ERRO] Falha ao salvar métrica:`, dbError);
      }
    });

  } catch (error) {
    console.error('🔥 [ERRO CRÍTICO] Falha ao iniciar WhatsApp:', error);
    if (res && !res.headersSent) {
      res.status(500).json({ error: 'Erro interno no servidor.' });
    }
  }
}

// ==========================================
// ROTA DA API: O botão de "Gerar QR Code" chama esta rota
// ==========================================
app.post('/api/whatsapp/qr', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;
  console.log(`\n🔵 [API] Requisição de botão (Novo QR Code) para: ${email}`);

  if (!email) {
    res.status(400).json({ error: 'Email obrigatório.' });
    return;
  }

  // Só limpamos a pasta física quando o cliente CLICA no botão para gerar um QR novo do zero.
  // Se for uma reconexão do sistema (515), esta rota não é chamada, preservando os arquivos.
  const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
  const sessionDir = path.join(__dirname, '..', 'auth_info_baileys', safeEmailFolder);

  if (fs.existsSync(sessionDir)) {
    console.log(`🧹 [SISTEMA] Apagando arquivos antigos para gerar um novo login...`);
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }

  if (sessions[email]) {
    sessions[email].ws.close();
    delete sessions[email];
  }

  // Dispara a função principal, enviando o objeto de resposta (res) do Express
  startWhatsApp(email, res);
});

// ==========================================
// ROTA: Desconectar WhatsApp
// ==========================================
app.post('/api/whatsapp/disconnect', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;
  
  if (!email) {
    res.status(400).json({ error: 'Email obrigatório.' });
    return;
  }

  try {
    if (sessions[email]) {
      sessions[email].ws.close();
      delete sessions[email];
    }
    const sessionDir = path.join(__dirname, '..', 'auth_info_baileys', email.replace(/[^a-zA-Z0-9]/g, '_'));
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
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
    res.status(400).json({ error: 'Email obrigatório.' });
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
// ROTAS PARA O DASHBOARD FRONTEND
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
    res.status(400).json({ error: 'Email obrigatório.' });
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
    res.status(400).json({ error: 'Email obrigatório.' });
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
  console.log(`\n🚀 ========================================`);
  console.log(`🚀 Backend rodando perfeitamente na porta ${port}`);
  console.log(`🚀 ========================================\n`);
});
