import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Importação das Rotas e Serviços
import stripeRoutes from './routes/stripe';
import { startWhatsApp, sessions, autoReconnectAll, disconnectWhatsApp } from './services/whatsapp';
// Importações para Google Auth
import { getTokensFromCode, getUserInfo } from './services/googleAuth'; 

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
// 3. ROTAS DE INTEGRAÇÃO E CONFIGURAÇÃO
// ==========================================

/**
 * ROTA DE CALLBACK DO GOOGLE CALENDAR
 * Esta rota recebe o código do Google e salva os tokens no Supabase (Profiles)
 */
app.get('/api/auth/google/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query; // 'state' deve conter o email ou ID do usuário

  if (!code) return res.status(400).send('Código não fornecido.');

  try {
    // 1. Troca o código pelos tokens (Access e Refresh)
    const tokens = await getTokensFromCode(code as string);
    
    // 2. Opcional: Busca info do usuário para garantir o email se o state falhar
    const userInfo = await getUserInfo(tokens);
    const userIdentifier = state || userInfo.email;

    if (!userIdentifier) throw new Error("Não foi possível identificar o usuário.");

    // 3. Salva os tokens na coluna googleAuth (JSONB) da tabela profiles
    const { error } = await supabase
      .from('profiles')
      .update({ 
        googleAuth: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiryDate: tokens.expiry_date
        }
      })
      .or(`email.eq.${userIdentifier},id.eq.${userIdentifier}`);

    if (error) throw error;

    // 4. Resposta visual para o usuário
    res.send(`
      <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
        <h1 style="color: #4CAF50;">Agenda Conectada!</h1>
        <p>A Lucy agora já pode organizar seus horários. Você já pode fechar esta aba.</p>
        <script>setTimeout(() => window.close(), 3000);</script>
      </div>
    `);

  } catch (error: any) {
    console.error("❌ Erro no Google Callback:", error.message);
    res.status(500).send("Erro ao conectar com o Google Calendar. Tente novamente.");
  }
});

// Rotas do Stripe
app.use('/api/stripe', stripeRoutes);

// Rota para salvar o Nome da Loja
app.post('/api/settings/store', async (req: Request, res: Response) => {
  const { email, storeName } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });
  try {
    const { error } = await supabase.from('profiles').update({ store_name: storeName }).eq('email', email);
    if (error) throw error;
    res.status(200).json({ message: 'Nome da loja atualizado com sucesso.' });
  } catch (error: any) {
    res.status(500).json({ error: 'Erro ao atualizar nome da loja.' });
  }
});

// Rota para salvar os horários de funcionamento (JSONB)
app.post('/api/settings/hours', async (req: Request, res: Response) => {
  const { email, workingHours, serviceDuration } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });
  try {
    const { error } = await supabase.from('profiles').update({ 
        working_hours: workingHours,
        service_duration: serviceDuration 
      }).eq('email', email);
    if (error) throw error;
    res.status(200).json({ message: 'Configurações de agenda atualizadas.' });
  } catch (error: any) {
    res.status(500).json({ error: 'Erro interno ao salvar horários.' });
  }
});

// Rota para atualizar o botão de IA (On/Off)
app.post('/api/settings/ai', async (req: Request, res: Response) => {
  const { email, aiEnabled } = req.body;
  try {
    await supabase.from('profiles').update({ is_ai_enabled: aiEnabled }).eq('email', email);
    res.status(200).json({ message: 'IA atualizada.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar IA.' });
  }
});

// Rota para buscar perfil do usuário
app.get('/api/user/profile', async (req: Request, res: Response) => {
  const email = req.query.email as string;
  const { data, error } = await supabase.from('profiles').select('*').eq('email', email).single();
  if (error) return res.status(404).json({ error: 'Usuário não encontrado.' });
  res.status(200).json(data);
});

// ==========================================
// 4. WHATSAPP E QR CODE
// ==========================================

app.post('/api/whatsapp/qr', async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });

  const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
  const sessionDir = path.join(__dirname, '..', 'auth_info_baileys', safeEmailFolder);

  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
  if (sessions[email]) {
    try { sessions[email].ws.close(); } catch (e) {}
    delete sessions[email];
  }
  startWhatsApp(email, res);
});

app.post('/api/whatsapp/disconnect', async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });
  try {
    await disconnectWhatsApp(email);
    res.status(200).json({ message: 'WhatsApp desconectado com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao processar desconexão.' });
  }
});

// ==========================================
// 5. INICIALIZAÇÃO
// ==========================================
app.get('/ping', (req, res) => res.status(200).send('pong'));
app.get('/', (req, res) => res.send('WBOT Backend Online!'));

app.listen(port, () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
  setTimeout(async () => {
    await autoReconnectAll();
  }, 5000);
});
