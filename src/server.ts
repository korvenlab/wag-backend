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
const sessions: Record<string, ReturnType<typeof makeWASocket>> = {};

// ==========================================
// ROTA: Geração de QR Code e Motor do Bot
// ==========================================
app.post('/api/whatsapp/qr', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;

  console.log(`\n🔵 [API] Requisição de QR Code recebida para: ${email}`);

  if (!email) {
    console.log("⚠️ [API] Falha: Email não fornecido.");
    res.status(400).json({ error: 'Email é obrigatório para gerar o QR Code.' });
    return;
  }

  try {
    const baseAuthDir = path.join(__dirname, '..', 'auth_info_baileys');
    if (!fs.existsSync(baseAuthDir)) {
      console.log("📁 [SISTEMA] Criando pasta raiz de autenticação...");
      fs.mkdirSync(baseAuthDir, { recursive: true });
    }

    const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
    const sessionDir = path.join(baseAuthDir, safeEmailFolder);

    if (fs.existsSync(sessionDir)) {
      console.log(`🧹 [SISTEMA] Limpando sessão antiga do cliente ${email}...`);
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    if (sessions[email]) {
      console.log(`🔌 [WHATSAPP] Encerrando conexão WebSocket ativa de ${email}...`);
      sessions[email].ws.close();
      delete sessions[email];
    }

    console.log("🔑 [WHATSAPP] Gerando novas chaves de autenticação...");
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    console.log("🌐 [WHATSAPP] Buscando a versão mais recente da API da Meta...");
    const { version } = await fetchLatestBaileysVersion();
    console.log(`✅ [WHATSAPP] Versão encontrada: v${version.join('.')}`);

    console.log("🚀 [WHATSAPP] Inicializando o motor do Baileys...");
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
    
    sock.ev.on('creds.update', () => {
      console.log(`💾 [WHATSAPP] Credenciais atualizadas e salvas para ${email}.`);
      saveCreds();
    });

    let qrSent = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === 'connecting') {
        console.log(`⏳ [WHATSAPP] Tentando estabelecer conexão com os servidores da Meta para ${email}...`);
      }

      if (qr && !qrSent) {
        console.log(`📸 [WHATSAPP] Novo QR Code gerado! Convertendo para imagem e enviando ao frontend...`);
        try {
          qrSent = true;
          const qrCodeImage = await qrcode.toDataURL(qr);
          if (!res.headersSent) {
            res.status(200).json({ qrCode: qrCodeImage });
            console.log(`✅ [API] QR Code enviado com sucesso para a tela de ${email}. Aguardando leitura...`);
          }
        } catch (err) {
          console.error('❌ [ERRO] Falha ao converter QR Code:', err);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Falha ao processar o QR Code' });
          }
        }
      }

      if (connection === 'close') {
        const boomError = lastDisconnect?.error as Boom;
        const statusCode = boomError?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`⚠️ [WHATSAPP] Conexão FECHADA para ${email}. Motivo (Status Code): ${statusCode}.`);
        console.log(`🔄 [WHATSAPP] O sistema vai tentar reconectar automaticamente? ${shouldReconnect ? 'SIM' : 'NÃO'}`);

        if (!shouldReconnect && !qrSent && !res.headersSent) {
           console.log(`🛑 [API] Falha permanente detectada. Avisando o frontend...`);
           res.status(500).json({ error: 'A conexão falhou permanentemente. Tente novamente.' });
        }
        
      } else if (connection === 'open') {
        console.log(`🎉 [WHATSAPP] SUCESSO! Aparelho de ${email} conectado e autenticado nativamente.`);
        if (!qrSent && !res.headersSent) {
           res.status(200).json({ message: 'Sessão conectada.' });
        }
      }
    });

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

        if (error) {
          console.error(`❌ [BANCO DE DADOS] Erro ao buscar perfil para métricas:`, error.message);
          return;
        }

        if (profile?.is_ai_enabled) {
          console.log(`🤖 [BOT] A IA está ATIVADA para ${email.split('@')[0]}. Processando métrica...`);
          
          const novasMensagens = (profile.messages_answered || 0) + 1;
          await supabase
            .from('profiles')
            .update({ messages_answered: novasMensagens })
            .eq('email', email);
            
          console.log(`📈 [MÉTRICAS] Contador atualizado: ${novasMensagens} mensagens respondidas.`);
        } else {
          console.log(`💤 [BOT] A IA está DESATIVADA para este cliente. Mensagem ignorada.`);
        }
      } catch (dbError) {
        console.error(`❌ [ERRO INTERNO] Falha ao processar mensagem do bot:`, dbError);
      }
    });

  } catch (criticalError) {
    console.error('🔥 [ERRO CRÍTICO] Falha catastrófica na rota de QR Code:', criticalError);
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
  console.log(`\n🔴 [API] Solicitação de DESCONEXÃO recebida para: ${email}`);
  
  if (!email) {
    res.status(400).json({ error: 'Email obrigatório.' });
    return;
  }

  try {
    if (sessions[email]) {
      sessions[email].ws.close();
      delete sessions[email];
      console.log(`🔌 [WHATSAPP] WebSocket fechado para ${email}.`);
    }
    const sessionDir = path.join(__dirname, '..', 'auth_info_baileys', email.replace(/[^a-zA-Z0-9]/g, '_'));
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log(`🗑️ [SISTEMA] Arquivos de sessão de ${email} apagados com sucesso.`);
    }
    
    res.status(200).json({ message: 'Desconectado.' });
  } catch (error) {
    console.error(`❌ [ERRO] Falha ao desconectar ${email}:`, error);
    res.status(500).json({ error: 'Erro ao desconectar.' });
  }
});

// ==========================================
// ROTA: Ligar/Desligar IA
// ==========================================
app.post('/api/settings/ai', async (req: Request, res: Response): Promise<void> => {
  const { email, aiEnabled } = req.body;
  console.log(`\n⚙️ [API] Alterando status da IA de ${email} para: ${aiEnabled ? 'LIGADO' : 'DESLIGADO'}`);
  
  if (!email) {
    res.status(400).json({ error: 'Email obrigatório.' });
    return;
  }

  try {
    await supabase.from('profiles').update({ is_ai_enabled: aiEnabled }).eq('email', email);
    console.log(`✅ [BANCO DE DADOS] Status da IA atualizado com sucesso.`);
    res.status(200).json({ message: 'Configuração atualizada!' });
  } catch (error) {
    console.error(`❌ [ERRO] Falha ao atualizar IA no banco:`, error);
    res.status(500).json({ error: 'Falha.' });
  }
});

// ==========================================
// ROTAS PARA O DASHBOARD FRONTEND
// ==========================================
app.get('/api/user/profile', async (req: Request, res: Response): Promise<void> => {
  const email = req.query.email as string;
  console.log(`\n📊 [API] Dashboard solicitou dados do perfil de: ${email}`);
  
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
    console.log(`✅ [BANCO DE DADOS] Dados do perfil enviados com sucesso.`);
    res.status(200).json(data);
  } catch (error) {
    console.error(`❌ [ERRO] Falha ao buscar perfil:`, error);
    res.status(500).json({ error: 'Erro ao buscar perfil.' });
  }
});

app.post('/api/settings/store', async (req: Request, res: Response): Promise<void> => {
  const { email, storeName } = req.body;
  console.log(`\n🏪 [API] Atualizando nome da loja de ${email} para: "${storeName}"`);
  
  if (!email) {
    res.status(400).json({ error: 'Email obrigatório.' });
    return;
  }

  try {
    await supabase.from('profiles').update({ store_name: storeName }).eq('email', email);
    console.log(`✅ [BANCO DE DADOS] Nome da loja atualizado.`);
    res.status(200).json({ message: 'Nome salvo com sucesso!' });
  } catch (error) {
    console.error(`❌ [ERRO] Falha ao salvar nome da loja:`, error);
    res.status(500).json({ error: 'Erro ao salvar.' });
  }
});

app.post('/api/settings/hours', async (req: Request, res: Response): Promise<void> => {
  const { email, startTime, endTime, activeDays, serviceDuration } = req.body;
  console.log(`\n⏰ [API] Atualizando horários de ${email}...`);
  
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
    
    console.log(`✅ [BANCO DE DADOS] Horários atualizados com sucesso.`);
    res.status(200).json({ message: 'Horários salvos com sucesso!' });
  } catch (error) {
    console.error(`❌ [ERRO] Falha ao salvar horários:`, error);
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
