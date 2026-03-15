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

// Importações dos nossos módulos separados
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
    
    sock.ev.on('creds.update', () => {
      saveCreds();
    });

    let qrSent = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

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

      if (connection === 'close') {
        const boomError = lastDisconnect?.error as Boom;
        const statusCode = boomError?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`⚠️ [WHATSAPP] Conexão FECHADA para ${email}. Status: ${statusCode}.`);

        if (shouldReconnect) {
          console.log(`🔄 [WHATSAPP] Meta solicitou reinício. Executando reconexão automática para ${email}...`);
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
    // INTEGRAÇÃO: OUVIR, PENSAR (AI) E AGENDAR (CALENDAR)
    // ========================================================
    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      
      if (!msg.message || msg.key.fromMe) return;

      const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!textMessage) return;

      const remoteJid = msg.key.remoteJid; 
      console.log(`\n💬 [BOT] Mensagem recebida de ${remoteJid}: "${textMessage}"`);

      try {
        // 1. Busca os dados da loja no banco
        const { data: profile, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('email', email)
          .single();

        if (error) return;

        if (profile?.is_ai_enabled) {
          console.log(`🤖 [GEMINI] Analisando intenção do cliente...`);
          
          const storeConfig = {
            storeName: profile.store_name || 'Nossa Loja',
            start: profile.start_time || '08:00',
            end: profile.end_time || '18:00',
            activeDays: profile.active_days || 'Segunda a Sexta',
            serviceDuration: profile.service_duration || 30
          };

          const history = ""; 

          // 2. Chama a Inteligência Artificial
          const aiResult = await analyzeMessage(history, textMessage, profile.is_ai_enabled, storeConfig);

          // 3. CENÁRIO A: Resposta normal (Dúvidas ou falta de dados)
          if (!aiResult.isScheduling && aiResult.response && remoteJid) {
            await sock.sendMessage(remoteJid, { text: aiResult.response });
            console.log(`✅ [WHATSAPP] Resposta enviada: "${aiResult.response}"`);
            
            const novasMensagens = (profile.messages_answered || 0) + 1;
            await supabase.from('profiles').update({ messages_answered: novasMensagens }).eq('email', email);
          }

          // 4. CENÁRIO B: IA identificou um agendamento válido!
          if (aiResult.isScheduling && aiResult.date && remoteJid) {
             console.log(`📅 [AGENDAMENTO] Data extraída: ${aiResult.date}. Verificando Google Calendar...`);
             
             const clientId = profile.id; 
             
             // Checa conflitos na agenda do Google
             const isAvailable = await checkAvailability(clientId, aiResult.date);

             if (isAvailable) {
                 console.log(`🟢 [CALENDÁRIO] Horário LIVRE! Criando evento...`);
                 
                 const clientName = msg.pushName || "Cliente WhatsApp";
                 const clientPhone = remoteJid.split('@')[0];
                 
                 // Cria o evento na agenda do lojista
                 const success = await createEvent(clientId, clientName, clientPhone, aiResult.date);
                 
                 if (success) {
                     const msgSucesso = aiResult.response || `✅ Agendamento confirmado com sucesso para o dia e horário solicitados! Te espero lá.`;
                     await sock.sendMessage(remoteJid, { text: msgSucesso });
                     
                     // Atualiza o Dashboard com a vitória
                     const novosAgendamentos = (profile.appointments_made || 0) + 1;
                     await supabase.from('profiles').update({ appointments_made: novosAgendamentos }).eq('email', email);
                     console.log(`📈 [MÉTRICAS] Agendamentos atualizados: ${novosAgendamentos}`);
                     
                 } else {
                     await sock.sendMessage(remoteJid, { text: "❌ Ocorreu um erro ao salvar na nossa agenda. Pode tentar novamente em alguns minutos?" });
                 }
                 
             } else {
                 console.log(`🔴 [CALENDÁRIO] Horário OCUPADO.`);
                 await sock.sendMessage(remoteJid, { text: "⚠️ Infelizmente esse horário já está ocupado na nossa agenda. Qual outro horário ficaria bom para você?" });
             }
          }

        }
      } catch (error) {
        console.error(`❌ [ERRO SISTEMA] Falha ao processar a requisição de IA/Calendário:`, error);
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
// ROTAS DA API
// ==========================================
app.post('/api/whatsapp/qr', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;
  console.log(`\n🔵 [API] Requisição de botão (Novo QR Code) para: ${email}`);

  if (!email) {
    res.status(400).json({ error: 'Email obrigatório.' });
    return;
  }

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

  startWhatsApp(email, res);
});

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
