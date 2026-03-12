import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import qrcode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("ERRO FATAL: Chaves do Supabase não encontradas no arquivo .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Dicionário para guardar instâncias de WhatsApp em memória
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

  // Cria um identificador seguro para a pasta baseando-se no email
  const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
  const sessionDir = path.join(__dirname, '..', 'auth_info_baileys', safeEmailFolder);

  // Força uma sessão nova apagando as credenciais antigas
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }

  // Fecha o socket antigo caso o utilizador tenha clicado novamente no botão
  if (sessions[email]) {
    sessions[email].ws.close();
    delete sessions[email];
  }

  // Inicializa a gestão de estado do Baileys
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }) // Desliga os logs excessivos
  });

  sessions[email] = sock;

  sock.ev.on('creds.update', saveCreds);

  let qrSent = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Se o Baileys gerou o texto do QR, convertemos para Imagem e enviamos
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
      const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`Conexão fechada para ${email}. Reconectar? ${shouldReconnect}`);
    } else if (connection === 'open') {
      console.log(`WhatsApp conectado com sucesso para: ${email}`);
      // Resposta de salvaguarda caso a rota ainda esteja aberta
      if (!qrSent && !res.headersSent) {
         res.status(200).json({ message: 'Sessão conectada.' });
      }
    }
  });
});

// ==========================================
// ROTA 2: Ligar/Desligar a Inteligência Artificial
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

    res.status(200).json({ message: 'Configuração de IA atualizada com sucesso!' });
  } catch (error) {
    console.error('Erro ao atualizar banco de dados:', error);
    res.status(500).json({ error: 'Falha ao salvar as configurações.' });
  }
});

// ==========================================
// ROTA BÁSICA: Teste de saúde
// ==========================================
app.get('/', (req: Request, res: Response) => {
  res.send('Servidor TS com Baileys está rodando perfeitamente!');
});

app.listen(port, () => {
  console.log(`Backend rodando na porta ${port}`);
});
