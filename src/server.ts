import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

import stripeRoutes from './routes/stripe';
import { startWhatsApp, autoReconnectAll, disconnectWhatsApp } from './services/whatsapp';
// FEATURE: Importação dos serviços do Google para restaurar o fluxo de agenda
import { generateAuthUrl, getTokensFromCode } from './services/googleAuth'; 

const app = express();
const port: number = process.env.PORT ? Number(process.env.PORT) : 3000;

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

app.use(cors({
  origin: true, 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature'],
  credentials: true 
}));

app.use('/api/stripe', stripeRoutes);
app.use(express.json());

// --- 1. ROTA DE PERFIL ---
app.get('/api/user/profile', async (req: Request, res: Response) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email necessário' });

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('email', String(email).trim())
      .single();

    if (error || !data) return res.status(404).json({ error: 'Perfil não encontrado' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// --- 2. ROTAS DE AUTENTICAÇÃO GOOGLE (OAUTH DIRETO) ---
app.get('/api/auth/google/url', (req: Request, res: Response) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email necessário' });
  const url = generateAuthUrl(email as string);
  res.json({ url });
});

app.get('/api/auth/google/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Sem código de autorização.');

  try {
    const tokens = await getTokensFromCode(code as string);
    const userEmail = (state as string);

    await supabase
      .from('profiles')
      .update({ 
        googleAuth: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiryDate: tokens.expiry_date,
          updatedAt: new Date().toISOString()
        }
      }).eq('email', userEmail.toLowerCase().trim());

    res.send('<h1>✅ Agenda Conectada!</h1><script>setTimeout(()=>window.close(),2500)</script>');
  } catch (error: any) {
    res.status(500).send("Erro ao vincular conta Google.");
  }
});

// --- 3. CONFIGURAÇÕES (IA, Agenda e Loja) ---
app.post('/api/settings/ai', async (req: Request, res: Response) => {
  const { email, is_ai_enabled } = req.body;
  await supabase.from('profiles').update({ is_ai_enabled }).eq('email', email);
  res.json({ ok: true });
});

app.post('/api/settings/hours', async (req: Request, res: Response) => {
  const { email, workingHours, serviceDuration } = req.body;
  await supabase.from('profiles').update({ working_hours: workingHours, service_duration: serviceDuration }).eq('email', email);
  res.json({ ok: true });
});

app.post('/api/settings/store', async (req: Request, res: Response) => {
  const { email, storeName } = req.body;
  await supabase.from('profiles').update({ store_name: storeName }).eq('email', email);
  res.json({ ok: true });
});

// --- 4. AUTH SYNC (Login inicial com salvamento de Tokens) ---
// FEATURE: Agora recebe e estrutura o objeto googleAuth completo vindo do Frontend
app.post('/api/auth/sync', async (req: Request, res: Response) => {
  const { id, email, accessToken, refreshToken, expiresAt } = req.body;
  
  if (!email || !id) return res.status(400).json({ error: 'ID e Email são obrigatórios' });

  try {
    // Montagem do objeto JSONB para a coluna googleAuth
    const googleAuthData = accessToken ? {
      updatedAt: new Date().toISOString(),
      expiryDate: expiresAt ? Number(expiresAt) * 1000 : null,
      accessToken,
      refreshToken: refreshToken || null
    } : undefined;

    const { data, error } = await supabase
      .from('profiles')
      .upsert({ 
        id, 
        email: String(email).trim().toLowerCase(),
        // Se houver googleAuthData, ele atualiza; se não houver, mantém o que está lá
        ...(googleAuthData && { googleAuth: googleAuthData })
      }, { onConflict: 'email' })
      .select()
      .single();

    if (error) throw error;
    res.json({ ok: true, user: data });
  } catch (err: any) {
    console.error("❌ Erro na sincronização:", err.message);
    res.status(500).json({ error: 'Erro na sincronização' });
  }
});

// --- 5. WHATSAPP ROUTES ---
app.post('/api/whatsapp/qr', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email necessário' });
  startWhatsApp(email, res);
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  const { email } = req.body;
  await disconnectWhatsApp(email);
  res.json({ ok: true });
});

// --- 6. BOOT ---
app.get('/ping', (req, res) => res.send('pong'));

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Wagoo Online na porta ${port}`);
  autoReconnectAll().catch(err => console.error("Erro na reconexão automática:", err));
});
