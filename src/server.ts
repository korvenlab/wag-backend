import dotenv from 'dotenv';
// IMPORTANTE: carregar as variáveis de ambiente ANTES de importar outras rotas e serviços!
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Importação das Rotas e Serviços
import stripeRoutes from './routes/stripe';
import { startWhatsApp, sessions, autoReconnectAll, disconnectWhatsApp } from './services/whatsapp';
import { getTokensFromCode, getUserInfo, generateAuthUrl } from './services/googleAuth'; 

const app = express();
const port = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ==========================================
// 1. STRIPE E WEBHOOKS
// ==========================================
// O webhook do Stripe EXIGE o corpo da requisição "raw" para validar a assinatura
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
// Rotas normais do Stripe
app.use('/api/stripe', express.json(), stripeRoutes);

// ==========================================
// 2. CONFIGURAÇÃO DO CORS
// ==========================================
const allowedOrigins = [
  'https://wagbot.vercel.app',
  'https://wagbot-korvenlabcontato-4447s-projects.vercel.app',
  'https://wag-frontend-korvenlabcontato-4447s-projects.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    
    const isAllowed = allowedOrigins.indexOf(origin) !== -1 || origin.includes('vercel.app');
    
    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error('Bloqueado pelo CORS: Origem não permitida.'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature'],
  credentials: true 
}));

app.use(express.json());

// ==========================================
// 3. ROTAS DE INTEGRAÇÃO (GOOGLE AUTH)
// ==========================================

app.post('/api/auth/sync', async (req: Request, res: Response) => {
  const { email, accessToken, refreshToken, expiresAt } = req.body;

  console.log("-----------------------------------------");
  console.log("📥 [SYNC] Dados recebidos:", { email, hasAccess: !!accessToken, hasRefresh: !!refreshToken });

  if (!email || !accessToken) {
    return res.status(400).json({ error: 'Dados incompletos.' });
  }

  try {
    const googleAuthData = {
      accessToken,
      refreshToken: refreshToken || null,
      expiryDate: expiresAt ? Number(expiresAt) * 1000 : null,
      updatedAt: new Date().toISOString()
    };

    // Usando UPSERT para evitar erros caso o perfil ainda não exista
    const { data, error } = await supabase
      .from('profiles')
      .upsert({ 
        email: email.toLowerCase().trim(),
        googleAuth: googleAuthData,
        updated_at: new Date().toISOString()
      }, { onConflict: 'email' })
      .select();

    if (error) {
      console.error("❌ [SUPABASE ERROR]:", error.message);
      return res.status(500).json({ error: error.message });
    }

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

    // Usando UPSERT na rota de callback também
    await supabase
      .from('profiles')
      .upsert({ 
        email: userEmail.toLowerCase().trim(),
        googleAuth: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiryDate: tokens.expiry_date,
          updatedAt: new Date().toISOString()
        },
        updated_at: new Date().toISOString()
      }, { onConflict: 'email' });

    res.send('<h1>✅ Conectado! Feche esta aba.</h1><script>setTimeout(()=>window.close(),2000)</script>');
  } catch (error: any) {
    console.error("❌ [CALLBACK ERROR]:", error.message);
    res.status(500).send("Erro no callback.");
  }
});

// ==========================================
// 4. CONFIGURAÇÕES DO USUÁRIO
// ==========================================

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
// 5. WHATSAPP
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
// 6. BOOT
// ==========================================
app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('WBOT Backend Online!'));

// Configuração de IP '0.0.0.0' necessária para acesso externo no Render
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
  autoReconnectAll();
});
