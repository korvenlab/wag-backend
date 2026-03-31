import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

import stripeRoutes from './routes/stripe';
import { startWhatsApp, autoReconnectAll, disconnectWhatsApp } from './services/whatsapp';
import { generateAuthUrl, getTokensFromCode } from './services/googleAuth'; 

const app = express();
const port: number = process.env.PORT ? Number(process.env.PORT) : 3000;

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// 1. Configuração de CORS
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
      .eq('email', String(email).trim().toLowerCase())
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
  
  // O state passa o email para ser recuperado no callback
  const url = generateAuthUrl(String(email).toLowerCase().trim());
  res.json({ url });
});

app.get('/api/auth/google/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query; // 'state' contém o email do usuário
  if (!code) return res.status(400).send('Sem código de autorização.');

  try {
    const tokens = await getTokensFromCode(code as string);
    const userEmail = String(state).toLowerCase().trim();

    // Estrutura o objeto JSONB para a coluna googleAuth conforme esperado pela Lucy
    const googleAuthData = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: tokens.expiry_date,
      updatedAt: new Date().toISOString()
    };

    const { error } = await supabase
      .from('profiles')
      .update({ googleAuth: googleAuthData })
      .eq('email', userEmail);

    if (error) throw error;

    res.send(`
      <div style="font-family: sans-serif; text-align: center; padding-top: 50px;">
        <h1 style="color: #10b981;">✅ Agenda Conectada!</h1>
        <p>A Lucy agora tem acesso ao seu calendário. Você já pode fechar esta janela.</p>
        <script>setTimeout(() => window.close(), 3000)</script>
      </div>
    `);
  } catch (error: any) {
    console.error("❌ Erro no Callback Google:", error.message);
    res.status(500).send("Erro ao vincular conta Google. Tente novamente no painel.");
  }
});

// --- 3. CONFIGURAÇÕES (IA, Agenda e Loja) ---
app.post('/api/settings/ai', async (req: Request, res: Response) => {
  const { email, is_ai_enabled } = req.body;
  const userEmail = String(email).toLowerCase().trim();
  
  await supabase.from('profiles').update({ is_ai_enabled }).eq('email', userEmail);
  res.json({ ok: true });
});

app.post('/api/settings/hours', async (req: Request, res: Response) => {
  const { email, workingHours, serviceDuration } = req.body;
  const userEmail = String(email).toLowerCase().trim();

  await supabase.from('profiles')
    .update({ working_hours: workingHours, service_duration: serviceDuration })
    .eq('email', userEmail);
    
  res.json({ ok: true });
});

app.post('/api/settings/store', async (req: Request, res: Response) => {
  const { email, storeName } = req.body;
  const userEmail = String(email).toLowerCase().trim();

  await supabase.from('profiles').update({ store_name: storeName }).eq('email', userEmail);
  res.json({ ok: true });
});

// --- 4. AUTH SYNC (Login inicial com proteção de Refresh Token) ---
app.post('/api/auth/sync', async (req: Request, res: Response) => {
  const { id, email, accessToken, refreshToken, expiresAt } = req.body;
  
  if (!email || !id) return res.status(400).json({ error: 'ID e Email são obrigatórios' });
  const userEmail = String(email).trim().toLowerCase();

  try {
    // 🔍 Busca perfil atual para não perder o refreshToken se o Google não enviar de novo
    const { data: currentProfile } = await supabase
      .from('profiles')
      .select('googleAuth')
      .eq('email', userEmail)
      .single();

    const googleAuthData = accessToken ? {
      updatedAt: new Date().toISOString(),
      expiryDate: expiresAt ? Number(expiresAt) * 1000 : (currentProfile?.googleAuth?.expiryDate || null),
      accessToken,
      // Preserva o refreshToken antigo se o novo vier vazio (comum em logins subsequentes)
      refreshToken: refreshToken || currentProfile?.googleAuth?.refreshToken || null
    } : undefined;

    const { data, error } = await supabase
      .from('profiles')
      .upsert({ 
        id, 
        email: userEmail,
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
  startWhatsApp(String(email).toLowerCase().trim(), res);
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  const { email } = req.body;
  await disconnectWhatsApp(String(email).toLowerCase().trim());
  res.json({ ok: true });
});

// --- 6. MONITORAMENTO E BOOT ---
app.get('/ping', (req, res) => res.send('pong'));

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Wagoo Online na porta ${port}`);
  autoReconnectAll().catch(err => console.error("Erro na reconexão automática:", err));
});
