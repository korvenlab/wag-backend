import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Importação das Rotas e Serviços
import stripeRoutes from './routes/stripe';
import { startWhatsApp, sessions, autoReconnectAll } from './services/whatsapp';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Configuração do Supabase para rotas administrativas
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ==========================================
// 1. WEBHOOK DO STRIPE (DEVE VIR ANTES DO JSON)
// ==========================================
// O Stripe precisa do corpo "raw" para validar a assinatura
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeRoutes);

// ==========================================
// 2. MIDDLEWARES GERAIS
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

// ==========================================
// 3. ROTAS DE INTEGRAÇÃO
// ==========================================

// Rotas do Stripe (Checkout Session, etc)
app.use('/api/stripe', stripeRoutes);

// Rota de Health Check para o Cron-job externo
app.get('/ping', (req, res) => res.status(200).send('pong'));

// Rota para Gerar QR Code do WhatsApp
app.post('/api/whatsapp/qr', async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });

  const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
  const sessionDir = path.join(__dirname, '..', 'auth_info_baileys', safeEmailFolder);

  // Limpa sessão anterior se existir para garantir um novo QR Code limpo
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
  if (sessions[email]) {
    try { sessions[email].ws.close(); } catch (e) {}
    delete sessions[email];
  }

  // Inicia o processo de conexão e envia o QR pela res
  startWhatsApp(email, res);
});

// Rota para Desconectar WhatsApp
app.post('/api/whatsapp/disconnect', async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });

  if (sessions[email]) {
    try { sessions[email].ws.close(); } catch (e) {}
    delete sessions[email];
  }

  const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
  const sessionDir = path.join(__dirname, '..', 'auth_info_baileys', safeEmailFolder);
  
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });

  res.status(200).json({ message: 'WhatsApp desconectado com sucesso.' });
});

// Rota para atualizar o botão de IA (On/Off)
app.post('/api/settings/ai', async (req: Request, res: Response) => {
  const { email, aiEnabled } = req.body;
  await supabase.from('profiles').update({ is_ai_enabled: aiEnabled }).eq('email', email);
  res.status(200).json({ message: 'Configuração atualizada.' });
});

// Rota para buscar perfil do usuário
app.get('/api/user/profile', async (req: Request, res: Response) => {
  const email = req.query.email as string;
  const { data } = await supabase.from('profiles').select('*').eq('email', email).single();
  res.status(200).json(data);
});

app.get('/', (req, res) => res.send('WAG Backend Online!'));

// ==========================================
// 4. INICIALIZAÇÃO DO SERVIDOR
// ==========================================
app.listen(port, () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);

  // Tenta reconectar todos os usuários pagantes após 5 segundos
  // dando tempo para o banco e a rede estabilizarem
  setTimeout(async () => {
    await autoReconnectAll();
  }, 5000);
});
