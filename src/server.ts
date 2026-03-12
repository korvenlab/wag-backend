import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import qrcode from 'qrcode';
import { Client, LocalAuth } from 'whatsapp-web.js';

// Carrega as variáveis de ambiente (.env)
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Verificação de segurança obrigatória no TypeScript
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("ERRO FATAL: Chaves do Supabase não encontradas no arquivo .env");
  process.exit(1);
}

// Conexão com o Supabase usando a chave de serviço (Service Role)
const supabase = createClient(supabaseUrl, supabaseKey);

// Objeto tipado para guardar as sessões do WhatsApp
const sessions: Record<string, Client> = {};

// ==========================================
// ROTA 1: Geração de QR Code do WhatsApp
// ==========================================
app.post('/api/whatsapp/qr', async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;

  if (!email) {
    res.status(400).json({ error: 'Email é obrigatório para gerar o QR Code.' });
    return;
  }

  console.log(`Iniciando geração de QR Code para: ${email}`);

  // Destrói a sessão anterior se o utilizador pedir um novo QR
  if (sessions[email]) {
    await sessions[email].destroy();
    delete sessions[email];
  }

  // Cria um novo cliente do WhatsApp
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: email }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  sessions[email] = client;

  client.on('qr', async (qr: string) => {
    try {
      const qrCodeImage = await qrcode.toDataURL(qr);
      res.status(200).json({ qrCode: qrCodeImage });
    } catch (err) {
      console.error('Erro ao converter QR Code:', err);
      res.status(500).json({ error: 'Falha ao processar o QR Code' });
    }
  });

  client.on('ready', () => {
    console.log(`WhatsApp conectado com sucesso para: ${email}`);
    // No futuro, atualizaremos o Supabase para status_whatsapp: 'conectado'
  });

  client.initialize();
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

  console.log(`Alterando IA do cliente ${email} para: ${aiEnabled ? 'Ligada' : 'Desligada'}`);

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
  res.send('Servidor TS do WAG BOT está rodando 100%!');
});

app.listen(port, () => {
  console.log(`Backend rodando na porta ${port}`);
});
