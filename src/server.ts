import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import stripeRoutes from './routes/stripe';
import adminDashboardRoutes from './routes/adminDashboard';
import feedbackRoutes from './routes/feedback';
import promoRoutes from './routes/promo';
import barbeirosRoutes from './routes/barbeiros';
import calendarRoutes from './routes/calendar';
import { profileHasWagooAccess } from './lib/profileAccess';
import { profileHasMultiBarberPlan, profileSubscriptionTier } from './lib/profileMultiBarber';
import { getMaxBarbeirosSlots, WAGOO_PLANS } from './lib/wagooSubscription';
import { countBarbeirosForUser } from './lib/barbeiros';
import { syncCalendarShareSlug } from './lib/storeSlug';
import { pushAdminEvent } from './services/adminEvents';
import { startWhatsApp, autoReconnectAll, disconnectWhatsApp, installWhatsAppProcessSafetyNet } from './services/whatsapp';
import { generateAuthUrl, getTokensFromCode } from './services/googleAuth';
import { getUserFromBearerHeader } from './lib/supabaseAuthUser';
import { supabase } from './lib/supabase';

const app = express();
const port: number = process.env.PORT ? Number(process.env.PORT) : 3000;

installWhatsAppProcessSafetyNet();

// 1. Configuração de CORS (Essencial para o Frontend conseguir salvar configurações)
app.use(cors({
  origin: true, 
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'stripe-signature',
    'x-admin-secret',
    'x-api-key',
    'X-API-Key',
  ],
  credentials: true 
}));

app.use('/api/stripe', stripeRoutes);
app.use(express.json());
app.use('/feedback', feedbackRoutes);
app.use('/api/admin', adminDashboardRoutes);
app.use('/api/promo', promoRoutes);
app.use('/api/barbeiros', barbeirosRoutes);
app.use('/api/calendar', calendarRoutes);

// --- 1. ROTA DE PERFIL (somente dono da sessão — Bearer Supabase) ---
app.get('/api/user/profile', async (req: Request, res: Response) => {
  try {
    const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
    if (!auth.ok) {
      return res.status(401).json({
        error:
          auth.reason === 'missing_token'
            ? 'Envie Authorization: Bearer com o access_token da sessão.'
            : 'Sessão inválida ou expirada. Faça login novamente.',
      });
    }

    const { data, error } = await supabase.from('profiles').select('*').eq('id', auth.user.id).maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Perfil não encontrado' });
    const row = data as Record<string, unknown>;
    const tier = profileSubscriptionTier({
      subscription_tier: row.subscription_tier,
      has_paid: row.has_paid,
      multi_barber_plan: row.multi_barber_plan as boolean | null | undefined,
    });
    const maxTeamUsers = getMaxBarbeirosSlots(tier);
    const teamUsersUsed = await countBarbeirosForUser(auth.user.id);

    res.json({
      ...row,
      has_access: profileHasWagooAccess({
        has_paid: row.has_paid,
        complimentary_access_until: row.complimentary_access_until,
      }),
      subscription_tier: tier,
      multi_barber_plan: profileHasMultiBarberPlan({
        subscription_tier: row.subscription_tier,
        multi_barber_plan: row.multi_barber_plan as boolean | null | undefined,
        has_paid: row.has_paid,
      }),
      max_team_users: maxTeamUsers,
      team_users_used: teamUsersUsed,
      plan_label: tier ? WAGOO_PLANS[tier].label : null,
    });
  } catch {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// --- 2. ROTAS DE AUTENTICAÇÃO GOOGLE (OAUTH CORRIGIDO) ---
app.get('/api/auth/google/url', (req: Request, res: Response) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email necessário' });
  
  // O state passa o email para ser recuperado no callback e salvar no perfil correto
  const url = generateAuthUrl(String(email).toLowerCase().trim());
  res.json({ url });
});

/**
 * IMPORTANTE: No Google Cloud Console, a URI de redirecionamento deve ser:
 * https://wag-backend.onrender.com/api/auth/google/callback
 */
app.get('/api/auth/google/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query; // 'state' contém o email do usuário
  if (!code) return res.status(400).send('Sem código de autorização.');

  try {
    const tokens = await getTokensFromCode(code as string);
    const userEmail = String(state).toLowerCase().trim();

    // Estrutura o objeto JSONB para a coluna googleAuth exatamente como os serviços de calendário esperam
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
        <h1 style="color: #10b981;">✅ Agenda Conectada com Sucesso!</h1>
        <p>A Lucy já pode acessar seu calendário. Esta janela fechará automaticamente.</p>
        <script>setTimeout(() => window.close(), 3000)</script>
      </div>
    `);
  } catch (error: any) {
    console.error("❌ Erro no Callback Google:", error.message);
    res.status(500).send("Erro ao vincular conta Google. Verifique se o GOOGLE_CLIENT_SECRET está correto no Render.");
  }
});

// --- 3. CONFIGURAÇÕES (IA, Agenda e Loja) ---
app.post('/api/settings/ai', async (req: Request, res: Response) => {
  // Verificação dupla para aceitar 'aiEnabled' (frontend) ou 'is_ai_enabled' (banco)
  const { email, aiEnabled, is_ai_enabled } = req.body;
  const userEmail = String(email).toLowerCase().trim();
  const valueToSave = aiEnabled !== undefined ? aiEnabled : is_ai_enabled;
  
  const { error } = await supabase.from('profiles').update({ is_ai_enabled: valueToSave }).eq('email', userEmail);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/settings/hours', async (req: Request, res: Response) => {
  const { email, workingHours, serviceDuration } = req.body;
  const userEmail = String(email).toLowerCase().trim();

  const { error } = await supabase.from('profiles')
    .update({ working_hours: workingHours, service_duration: serviceDuration })
    .eq('email', userEmail);
    
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/settings/store', async (req: Request, res: Response) => {
  const { email, storeName } = req.body;
  const userEmail = String(email).toLowerCase().trim();

  const { data: existing } = await supabase
    .from('profiles')
    .select('id, calendar_share_token')
    .eq('email', userEmail)
    .maybeSingle();

  const { error } = await supabase.from('profiles').update({ store_name: storeName }).eq('email', userEmail);
  if (error) return res.status(500).json({ error: error.message });

  if (existing?.id && existing.calendar_share_token) {
    await syncCalendarShareSlug(supabase, existing.id, storeName, null);
  }

  res.json({ ok: true });
});

// --- 4. AUTH SYNC (Proteção de Refresh Token no Login) ---
app.post('/api/auth/sync', async (req: Request, res: Response) => {
  const { id, email, accessToken, refreshToken, expiresAt } = req.body;
  
  if (!email || !id) return res.status(400).json({ error: 'ID e Email são obrigatórios' });
  const userEmail = String(email).trim().toLowerCase();

  try {
    // 🔍 Busca o perfil existente para não apagar o refreshToken antigo (o Google só manda o refresh uma vez)
    const { data: currentProfile } = await supabase
      .from('profiles')
      .select('googleAuth')
      .eq('email', userEmail)
      .single();

    const googleAuthData = accessToken ? {
      updatedAt: new Date().toISOString(),
      expiryDate: expiresAt ? Number(expiresAt) * 1000 : (currentProfile?.googleAuth?.expiryDate || null),
      accessToken,
      // Se o login atual não trouxer refreshToken, mantém o que já estava salvo no banco
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
app.get('/health', (_req, res) =>
  res.status(200).type('application/json; charset=utf-8').json({ ok: true })
);

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Wagoo Online na porta ${port}`);
  pushAdminEvent('core', `API Wagoo inicializada na porta ${port}`, 'online');
  autoReconnectAll().catch(err => console.error("Erro na reconexão automática:", err));
});
