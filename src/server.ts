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
import { getMaxBarbeirosSlots, WAGOO_PLANS, tierSupportsReminders } from './lib/wagooSubscription';
import { countBarbeirosForUser } from './lib/barbeiros';
import { syncCalendarShareSlug } from './lib/storeSlug';
import { pushAdminEvent } from './services/adminEvents';
import { startWhatsApp, autoReconnectAll, disconnectWhatsApp, installWhatsAppProcessSafetyNet } from './services/whatsapp';
import { clampRemindBeforeMinutes, startReminderWorker } from './services/reminders';
import { normalizeResponseTemplates } from './lib/responseTemplates';
import { generateAuthUrl, getTokensFromCode } from './services/googleAuth';
import { getUserFromBearerHeader } from './lib/supabaseAuthUser';
import { supabase } from './lib/supabase';
import { isBusinessNicheId } from './lib/businessNiche';
import { requireBearerUser, sanitizeProfileForClient } from './lib/requireAuth';
import { createGoogleOAuthState, verifyGoogleOAuthState } from './lib/googleOAuthState';
import { log } from './lib/logger';

const app = express();
const port: number = process.env.PORT ? Number(process.env.PORT) : 3000;

installWhatsAppProcessSafetyNet();
log.info('CORE', 'safety net WhatsApp instalado');

const defaultOrigins = [
  'https://wagobot.com',
  'https://www.wagobot.com',
  'https://wagoobot.com',
  'https://www.wagoobot.com',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];
const allowedOrigins = new Set(
  [
    ...defaultOrigins,
    ...(process.env.FRONTEND_ORIGINS || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    process.env.FRONTEND_URL?.trim(),
  ].filter(Boolean) as string[],
);

app.use(cors({
  origin(origin, callback) {
    // Same-origin / curl / server-to-server (no Origin header)
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    // Preview deploys (Vercel/etc.) — só se FRONTEND_ORIGINS não restringir demais
    if (process.env.CORS_ALLOW_VERCEL === '1' && /\.vercel\.app$/.test(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'stripe-signature',
    'x-admin-secret',
    'x-api-key',
    'X-API-Key',
  ],
  credentials: true,
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
    const safe = sanitizeProfileForClient(row);

    res.json({
      ...safe,
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

// --- 2. GOOGLE CALENDAR OAUTH (state assinado + Bearer na URL) ---
app.get('/api/auth/google/url', async (req: Request, res: Response) => {
  const authed = await requireBearerUser(req, res);
  if (!authed) return;

  const state = createGoogleOAuthState(authed.user.id, authed.email);
  const url = generateAuthUrl(state);
  res.json({ url });
});

/**
 * IMPORTANTE: No Google Cloud Console, a URI de redirecionamento deve ser:
 * https://wag-backend.onrender.com/api/auth/google/callback
 */
app.get('/api/auth/google/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Sem código de autorização.');

  const verified = verifyGoogleOAuthState(state);
  if (!verified.ok) {
    return res.status(400).send(`Falha na ligação Google: ${verified.error}`);
  }

  try {
    const tokens = await getTokensFromCode(code as string);

    const { data: current } = await supabase
      .from('profiles')
      .select('googleAuth')
      .eq('id', verified.payload.sub)
      .maybeSingle();

    const prev = (current?.googleAuth || {}) as {
      refreshToken?: string | null;
    };

    const googleAuthData = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || prev.refreshToken || null,
      expiryDate: tokens.expiry_date,
      updatedAt: new Date().toISOString(),
    };

    const { error, data: updated } = await supabase
      .from('profiles')
      .update({ googleAuth: googleAuthData })
      .eq('id', verified.payload.sub)
      .eq('email', verified.payload.email)
      .select('id');

    if (error) throw error;
    if (!updated?.length) {
      return res.status(404).send('Perfil não encontrado para esta sessão.');
    }

    res.send(`
      <div style="font-family: sans-serif; text-align: center; padding-top: 50px;">
        <h1 style="color: #10b981;">Agenda conectada com sucesso!</h1>
        <p>O Wagoo já pode acessar seu calendário. Esta janela fechará automaticamente.</p>
        <script>setTimeout(() => window.close(), 3000)</script>
      </div>
    `);
  } catch (error: any) {
    console.error("❌ Erro no Callback Google:", error.message);
    res.status(500).send("Erro ao vincular conta Google. Verifique se o GOOGLE_CLIENT_SECRET está correto no Render.");
  }
});

// --- 3. CONFIGURAÇÕES (IA, Agenda e Loja) — Bearer obrigatório ---
app.post('/api/settings/ai', async (req: Request, res: Response) => {
  const authed = await requireBearerUser(req, res);
  if (!authed) return;

  const { aiEnabled, is_ai_enabled, aiUseEmojis, ai_use_emojis } = req.body;
  const patch: Record<string, boolean> = {};

  if (aiEnabled !== undefined || is_ai_enabled !== undefined) {
    patch.is_ai_enabled = aiEnabled !== undefined ? !!aiEnabled : !!is_ai_enabled;
  }
  if (aiUseEmojis !== undefined || ai_use_emojis !== undefined) {
    patch.ai_use_emojis = aiUseEmojis !== undefined ? !!aiUseEmojis : !!ai_use_emojis;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Nada para atualizar.' });
  }

  const { error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', authed.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, ...patch });
});

app.post('/api/settings/hours', async (req: Request, res: Response) => {
  const authed = await requireBearerUser(req, res);
  if (!authed) return;

  const { workingHours, serviceDuration } = req.body;

  const { error } = await supabase
    .from('profiles')
    .update({ working_hours: workingHours, service_duration: serviceDuration })
    .eq('id', authed.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/settings/reminders', async (req: Request, res: Response) => {
  const authed = await requireBearerUser(req, res);
  if (!authed) return;

  const { data: row, error: fetchErr } = await supabase
    .from('profiles')
    .select('subscription_tier, has_paid, multi_barber_plan')
    .eq('id', authed.user.id)
    .maybeSingle();

  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!row) return res.status(404).json({ error: 'Perfil não encontrado' });

  const tier = profileSubscriptionTier({
    subscription_tier: row.subscription_tier,
    has_paid: row.has_paid,
    multi_barber_plan: row.multi_barber_plan,
  });

  if (!tierSupportsReminders(tier)) {
    return res.status(403).json({
      error: 'Lembretes estão disponíveis nos planos Pro e Pro+.',
    });
  }

  const remindersEnabled = Boolean(
    req.body.remindersEnabled ?? req.body.reminders_enabled,
  );
  const remindBeforeMinutes = clampRemindBeforeMinutes(
    req.body.remindBeforeMinutes ?? req.body.remind_before_minutes,
  );

  const { error } = await supabase
    .from('profiles')
    .update({
      reminders_enabled: remindersEnabled,
      remind_before_minutes: remindBeforeMinutes,
    })
    .eq('id', authed.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({
    ok: true,
    reminders_enabled: remindersEnabled,
    remind_before_minutes: remindBeforeMinutes,
  });
});

app.get('/api/settings/templates', async (req: Request, res: Response) => {
  const authed = await requireBearerUser(req, res);
  if (!authed) return;

  const { data, error } = await supabase
    .from('profiles')
    .select('response_templates')
    .eq('id', authed.user.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Perfil não encontrado' });

  res.json({
    response_templates: normalizeResponseTemplates(data.response_templates),
  });
});

app.post('/api/settings/templates', async (req: Request, res: Response) => {
  const authed = await requireBearerUser(req, res);
  if (!authed) return;

  const templates = normalizeResponseTemplates(
    req.body.responseTemplates ?? req.body.response_templates ?? req.body,
  );

  const { error } = await supabase
    .from('profiles')
    .update({ response_templates: templates })
    .eq('id', authed.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, response_templates: templates });
});

app.post('/api/settings/store', async (req: Request, res: Response) => {
  const authed = await requireBearerUser(req, res);
  if (!authed) return;

  const { storeName, businessNiche, businessNicheCustom } = req.body;

  if (businessNiche !== undefined && businessNiche !== null && !isBusinessNicheId(businessNiche)) {
    return res.status(400).json({
      error: 'business_niche inválido',
      allowed: ['barbearia', 'salao', 'manicure', 'estetica', 'outro'],
    });
  }

  if (businessNiche === 'outro') {
    const custom = typeof businessNicheCustom === 'string' ? businessNicheCustom.trim() : '';
    if (!custom) {
      return res.status(400).json({ error: 'Descreva o nicho quando escolher "outro".' });
    }
  }

  const { data: existing } = await supabase
    .from('profiles')
    .select('id, calendar_share_token')
    .eq('id', authed.user.id)
    .maybeSingle();

  const updatePayload: Record<string, unknown> = {};
  if (storeName !== undefined) updatePayload.store_name = storeName;
  if (businessNiche !== undefined) {
    updatePayload.business_niche = businessNiche;
    updatePayload.business_niche_custom =
      businessNiche === 'outro'
        ? String(businessNicheCustom).trim()
        : null;
  }

  if (Object.keys(updatePayload).length === 0) {
    return res.status(400).json({ error: 'Nada para actualizar' });
  }

  const { error } = await supabase
    .from('profiles')
    .update(updatePayload)
    .eq('id', authed.user.id);
  if (error) return res.status(500).json({ error: error.message });

  if (existing?.id && existing.calendar_share_token && storeName !== undefined) {
    await syncCalendarShareSlug(supabase, existing.id, storeName, null);
  }

  res.json({ ok: true });
});

// --- 4. AUTH SYNC (Bearer + só o próprio user) ---
app.post('/api/auth/sync', async (req: Request, res: Response) => {
  const authed = await requireBearerUser(req, res);
  if (!authed) return;

  const { accessToken, refreshToken, expiresAt } = req.body;
  const userEmail = authed.email;
  const id = authed.user.id;

  try {
    const { data: currentProfile } = await supabase
      .from('profiles')
      .select('googleAuth')
      .eq('id', id)
      .maybeSingle();

    const googleAuthData = accessToken ? {
      updatedAt: new Date().toISOString(),
      expiryDate: expiresAt ? Number(expiresAt) * 1000 : (currentProfile?.googleAuth?.expiryDate || null),
      accessToken,
      refreshToken: refreshToken || currentProfile?.googleAuth?.refreshToken || null
    } : undefined;

    const { error } = await supabase
      .from('profiles')
      .upsert({
        id,
        email: userEmail,
        ...(googleAuthData && { googleAuth: googleAuthData })
      }, { onConflict: 'email' });

    if (error) throw error;
    log.info('AUTH', 'sync OK', { email: userEmail, userId: id, hasGoogleToken: !!accessToken });
    res.json({ ok: true });
  } catch (err: any) {
    log.error('AUTH', 'erro na sincronização', err, { email: userEmail, userId: id });
    res.status(500).json({ error: 'Erro na sincronização' });
  }
});

// --- 5. WHATSAPP (Bearer — só a própria conta) ---
app.post('/api/whatsapp/qr', async (req, res) => {
  const authed = await requireBearerUser(req, res);
  if (!authed) return;
  log.step('WA', 'POST /api/whatsapp/qr', { email: authed.email });
  startWhatsApp(authed.email, res).catch((err) => {
    log.error('WA', 'startWhatsApp rejeitado na rota QR', err, { email: authed.email });
    if (!res.headersSent) res.status(500).json({ error: 'Falha ao gerar QR' });
  });
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  const authed = await requireBearerUser(req, res);
  if (!authed) return;
  log.step('WA', 'POST /api/whatsapp/disconnect', { email: authed.email });
  try {
    await disconnectWhatsApp(authed.email);
    res.json({ ok: true });
  } catch (err) {
    log.error('WA', 'disconnect falhou na rota', err, { email: authed.email });
    res.status(500).json({ error: 'Falha ao desconectar' });
  }
});

// --- 6. MONITORAMENTO E BOOT ---
app.get('/ping', (req, res) => res.send('pong'));
app.get('/health', (_req, res) =>
  res.status(200).type('application/json; charset=utf-8').json({ ok: true })
);

app.listen(port, '0.0.0.0', () => {
  log.info('CORE', `API online na porta ${port}`);
  pushAdminEvent('core', `API Wagoo inicializada na porta ${port}`, 'online');
  autoReconnectAll().catch((err) => log.error('WA', 'Erro na reconexão automática', err));
  startReminderWorker();
});
