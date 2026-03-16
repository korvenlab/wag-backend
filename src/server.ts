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
import { getTokensFromCode, getUserInfo, generateAuthUrl } from './services/googleAuth'; 

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Configuração do Supabase para rotas administrativas (Service Role para poder dar bypass no RLS)
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
 * NOVO: ROTA DE SINCRONIZAÇÃO AUTOMÁTICA (ONE-CLICK)
 * Essa rota é chamada pela LoginPage.tsx imediatamente após o login bem sucedido.
 */
app.post('/api/auth/sync', async (req: Request, res: Response) => {
  const { email, accessToken, refreshToken, expiresAt } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email não fornecido para sincronização.' });
  }

  try {
    console.log(`🔄 Sincronizando tokens da agenda para: ${email}`);

    // Atualiza a coluna googleAuth com os tokens capturados no login
    const { error } = await supabase
      .from('profiles')
      .update({ 
        googleAuth: {
          accessToken,
          refreshToken,
          expiryDate: expiresAt ? expiresAt * 1000 : null // Supabase envia expires_at em segundos, convertemos para ms
        }
      })
      .eq('email', email);

    if (error) throw error;

    console.log(`✅ Agenda sincronizada para ${email}`);
    res.status(200).json({ message: 'Tokens sincronizados com sucesso.' });
  } catch (error: any) {
    console.error("❌ Erro na sincronização automática:", error.message);
    res.status(500).json({ error: 'Erro interno ao sincronizar credenciais.' });
  }
});

/**
 * ROTA PARA GERAR A URL DE AUTENTICAÇÃO DO GOOGLE (Fallback / Manual)
 */
app.get('/api/auth/google/url', (req: Request, res: Response) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email é necessário' });
  const url = generateAuthUrl(email as string);
  res.json({ url });
});

/**
 * ROTA DE CALLBACK DO GOOGLE CALENDAR
 */
app.get('/api/auth/google/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query;

  if (!code) return res.status(400).send('Código não fornecido.');

  try {
    const tokens = await getTokensFromCode(code as string);
    const userInfo = await getUserInfo(tokens);
    const userIdentifier = state || userInfo.email;

    if (!userIdentifier) throw new Error("Não foi possível identificar o usuário.");

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

    res.send(`
      <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
        <h1 style="color: #4CAF50;">Agenda Conectada!</h1>
        <p>A Lucy agora já pode organizar seus horários. Você já pode fechar esta aba.</p>
        <script>setTimeout(() => window.close(), 3000);</script>
      </div>
    `);

  } catch (error: any) {
    console.error("❌ Erro no Google Callback:", error.message);
    res.status(500).send("Erro ao conectar com o Google Calendar.");
  }
});

// --- Configurações de Loja e IA ---

app.post('/api/settings/store', async (req: Request, res: Response) => {
  const { email, storeName } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });
  try {
    const { error } = await supabase.from('profiles').update({ store_name: storeName }).eq('email', email);
    if (error) throw error;
    res.status(200).json({ message: 'Nome da loja atualizado.' });
  } catch (error: any) {
    res.status(500).json({ error: 'Erro ao atualizar nome da loja.' });
  }
});

app.post('/api/settings/hours', async (req: Request, res: Response) => {
  const { email, workingHours, serviceDuration } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });
  try {
    const { error } = await supabase.from('profiles').update({ 
        working_hours: workingHours,
        service_duration: serviceDuration 
      }).eq('email', email);
    if (error) throw error;
    res.status(200).json({ message: 'Agenda atualizada.' });
  } catch (error: any) {
    res.status(500).json({ error: 'Erro ao salvar horários.' });
  }
});

app.post('/api/settings/ai', async (req: Request, res: Response) => {
  const { email, aiEnabled } = req.body;
  try {
    await supabase.from('profiles').update({ is_ai_enabled: aiEnabled }).eq('email', email);
    res.status(200).json({ message: 'IA atualizada.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar IA.' });
  }
});

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
    res.status(200).json({ message: 'WhatsApp desconectado.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao desconectar.' });
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
