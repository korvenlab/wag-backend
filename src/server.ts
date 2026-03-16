import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Importação das Rotas e Serviços
import stripeRoutes from './routes/stripe';
import { startWhatsApp, sessions, autoReconnectAll, disconnectWhatsApp } from './services/whatsapp';
import { getTokensFromCode, getUserInfo, generateAuthUrl } from './services/googleAuth'; 

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ==========================================
// 1. WEBHOOK DO STRIPE (Deve vir antes do express.json)
// ==========================================
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeRoutes);

// ==========================================
// 2. CONFIGURAÇÃO CORRIGIDA DO CORS
// ==========================================
const allowedOrigins = [
  'https://wagbot.vercel.app',
  'https://wagbot-korvenlabcontato-4447s-projects.vercel.app', // URL que deu erro
  'https://wag-frontend-korvenlabcontato-4447s-projects.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000'
];

app.use(cors({
  origin: function (origin, callback) {
    // Permite requisições sem origin (como apps mobile ou postman)
    if (!origin) return callback(null, true);
    
    // Verifica se a origin está na lista ou se é um subdomínio do vercel do projeto
    const isAllowed = allowedOrigins.indexOf(origin) !== -1 || origin.includes('vercel.app');
    
    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error('Bloqueado pelo CORS: Origem não permitida.'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true // Importante para cookies/sessões se necessário
}));

app.use(express.json());

// ==========================================
// 3. ROTAS DE INTEGRAÇÃO
// ==========================================

app.post('/api/auth/sync', async (req: Request, res: Response) => {
  const { email, accessToken, refreshToken, expiresAt } = req.body;

  console.log("-----------------------------------------");
  console.log("📥 [SYNC] Dados recebidos:", { email, hasAccess: !!accessToken, hasRefresh: !!refreshToken });

  if (!email || !accessToken) {
    return res.status(400).json({ error: 'Dados incompletos.' });
  }

  try {
    const { data, error } = await supabase
      .from('profiles')
      .update({ 
        googleAuth: {
          accessToken,
          refreshToken,
          expiryDate: expiresAt ? Number(expiresAt) * 1000 : null,
          updatedAt: new Date().toISOString()
        }
      })
      .eq('email', email)
      .select();

    if (error) throw error;

    console.log(`✅ [SYNC] Sucesso para: ${email}`);
    res.status(200).json({ message: 'Sincronizado.', data });
  } catch (error: any) {
    console.error("❌ [SYNC] Erro:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/auth/google/url', (req: Request, res: Response) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email necessário' });
  const url = generateAuthUrl(email as string);
  res.json({ url });
});

app.get('/api/auth/google/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Sem código.');

  try {
    const tokens = await getTokensFromCode(code as string);
    const userInfo = await getUserInfo(tokens);
    const userEmail = (state as string) || userInfo.email;

    await supabase
      .from('profiles')
      .update({ 
        googleAuth: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiryDate: tokens.expiry_date,
          updatedAt: new Date().toISOString()
        }
      })
      .eq('email', userEmail);

    res.send('<h1>✅ Conectado! Feche esta aba.</h1><script>setTimeout(()=>window.close(),2000)</script>');
  } catch (error: any) {
    res.status(500).send("Erro no callback.");
  }
});

// --- Outras Rotas ---

app.post('/api/settings/store', async (req: Request, res: Response) => {
  const { email, storeName } = req.body;
  await supabase.from('profiles').update({ store_name: storeName }).eq('email', email);
  res.json({ ok: true });
});

app.post('/api/settings/hours', async (req: Request, res: Response) => {
  const { email, workingHours, serviceDuration } = req.body;
  await supabase.from('profiles').update({ working_hours: workingHours, service_duration: serviceDuration }).eq('email', email);
  res.json({ ok: true });
});

app.post('/api/settings/ai', async (req: Request, res: Response) => {
  const { email, aiEnabled } = req.body;
  await supabase.from('profiles').update({ is_ai_enabled: aiEnabled }).eq('email', email);
  res.json({ ok: true });
});

app.get('/api/user/profile', async (req: Request, res: Response) => {
  const email = req.query.email as string;
  const { data, error } = await supabase.from('profiles').select('*').eq('email', email).single();
  if (error) return res.status(404).json({ error: 'Não encontrado' });
  res.json(data);
});

// ==========================================
// 4. WHATSAPP
// ==========================================

app.post('/api/whatsapp/qr', async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email necessário' });
  startWhatsApp(email, res);
});

app.post('/api/whatsapp/disconnect', async (req: Request, res: Response) => {
  const { email } = req.body;
  await disconnectWhatsApp(email);
  res.json({ ok: true });
});

// ==========================================
// 5. BOOT
// ==========================================
app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('WBOT Backend Online!'));

app.listen(port, () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
  autoReconnectAll();
});
