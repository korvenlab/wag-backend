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

// Carrega as variáveis de ambiente (.env)
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Verificação de segurança das chaves do banco de dados
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("ERRO FATAL: Chaves do Supabase não encontradas no arquivo .env");
  process.exit(1);
}

// Conexão administrativa com o Supabase
const supabase = createClient(supabaseUrl, supabaseKey);

// Dicionário em memória para gerir as conexões ativas do WhatsApp
const sessions: Record<string, ReturnType<typeof makeWASocket>> = {};

// ==========================================
// ROTA 1: Geração de QR Code via Baileys
// ==========================================
app.post('/api/whatsapp/qr', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;

  if (!email) {
    res.status(400).json({ error: 'Email é obrigatório para gerar o QR Code.' });
    return;
  }

  // 1. GARANTIA DE PASTA: Cria a pasta principal se ela não existir
  const baseAuthDir = path.join(__dirname, '..', 'auth_info_baileys');
  if (!fs.existsSync(baseAuthDir)) {
    fs.mkdirSync(baseAuthDir, { recursive: true });
  }

  // Cria a pasta específica do cliente
  const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
  const sessionDir = path.join(baseAuthDir, safeEmailFolder);

  // Se o cliente pedir um novo QR Code, apagamos a sessão antiga localmente
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }

  // Derruba o socket antigo se ele ainda estiver ativo na memória
  if (sessions[email]) {
    sessions[email].ws.close();
    delete sessions[email];
  }

  // Inicializa o gerenciador de chaves do Baileys
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  // 2. BUSCA DA VERSÃO ATUALIZADA (CORREÇÃO DO ERRO 405)
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Iniciando WhatsApp v${version.join('.')} para o email: ${email}`);

  const sock = makeWASocket({
    version, // Injeta a versão atualizada para a Meta não rejeitar a conexão
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

    // Converte o código bruto do WhatsApp em uma imagem Base64
    if (qr && !qrSent) {
      try {
        qrSent = true;
        const qrCodeImage = await qrcode.toDataURL(qr);
        res.status(200).json({ qrCode: qrCodeImage });
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

      console.log(`Conexão fechada para ${email}. Status: ${statusCode}. Reconectar? ${shouldReconnect}`);
      
      if (!shouldReconnect && !qrSent && !res.headersSent) {
         res.status(500).json({ error: 'A conexão falhou permanentemente. Tente novamente.' });
      }
      
    } else if (connection === 'open') {
      console.log(`WhatsApp conectado com sucesso para: ${email}`);
      if (!qrSent && !res.headersSent) {
         res.status(200).json({ message: 'Sessão conectada nativamente.' });
      }
    }
  });
});

// ==========================================
// ROTA 2: Desconectar o WhatsApp de forma segura
// ==========================================
app.post('/api/whatsapp/disconnect', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;

  if (!email) {
    res.status(400).json({ error: 'Email é obrigatório.' });
    return;
  }

  try {
    if (sessions[email]) {
      sessions[email].ws.close();
      delete sessions[email];
    }

    const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
    const sessionDir = path.join(__dirname, '..', 'auth_info_baileys', safeEmailFolder);
    
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    res.status(200).json({ message: 'WhatsApp desconectado com sucesso.' });
  } catch (error) {
    console.error('Erro ao tentar desconectar:', error);
    res.status(500).json({ error: 'Erro ao desconectar.' });
  }
});

// ==========================================
// ROTA 3: Ligar/Desligar a Inteligência Artificial
// ==========================================
app.post('/api/settings/ai', async (req: Request, res: Response): Promise<void> => {
  const { email, aiEnabled } = req.body;

  if (!email) {
    res.status(400).json({ error: 'Email é obrigatório.' });
    return;
  }

  try {
    const { error } = await supabase
      .from('profiles')
      .update({ is_ai_enabled: aiEnabled })
      .eq('email', email);

    if (error) {
      throw error;
    }

    res.status(200).json({ message: 'Configuração atualizada!' });
  } catch (error) {
    console.error('Erro no Supabase:', error);
    res.status(500).json({ error: 'Falha ao salvar as configurações.' });
  }
});

app.get('/', (req: Request, res: Response) => {
  res.send('API do WAG BOT operando normalmente!');
});

app.listen(port, () => {
  console.log(`🚀 Backend rodando na porta ${port}`);
});
