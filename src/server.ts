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

// Configuração do Supabase com Service Role para bypass de RLS
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ==========================================
// 1. WEBHOOK DO STRIPE
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
 * SINCRONIZAÇÃO AUTOMÁTICA (Login "One-Click")
 */
app.post('/api/auth/sync', async (req: Request, res: Response) => {
  const { email, accessToken, refreshToken, expiresAt } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email não fornecido para sincronização.' });
  }

  try {
    console.log(`🔄 Sincronizando tokens One-Click para: ${email}`);

    const { data, error } = await supabase
      .from('profiles')
      .update({ 
        googleAuth: {
          accessToken,
          refreshToken,
          expiryDate: expiresAt ? Number(expiresAt) * 1000 : null
        }
      })
      .eq('email', email)
      .select();

    if (error) throw error;

    if (!data || data.length === 0) {
      console.warn(`⚠️ Perfil não encontrado para o email: ${email}`);
      return res.status(404).json({ error: 'Perfil não encontrado no banco.' });
    }

    console.log(`✅ Agenda sincronizada via login para ${email}`);
    res.status(200).json({ message: 'Tokens sincronizados com sucesso.' });
  } catch (error: any) {
    console.error("❌ Erro na sincronização automática:", error.message);
    res.status(500).json({ error: 'Erro interno ao sincronizar credenciais.' });
  }
});

/**
 * URL DE AUTENTICAÇÃO (Fallback / Manual)
 */
app.get('/api/auth/google/url', (req: Request, res: Response) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email é necessário' });
  const url = generateAuthUrl(email as string);
  res.json({ url });
});

/**
 * CALLBACK DO GOOGLE CALENDAR (Pós consentimento manual)
 */
app.get('/api/auth/google/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query;

  if (!code) return res.status(400).send('Código não fornecido.');

  try {
    const tokens = await getTokensFromCode(code as string);
    const userInfo = await getUserInfo(tokens);
    
    // Fallback: se o state não vier, usamos o email confirmado pelo Google
    const userEmail = (state as string) || userInfo.email;

    if (!userEmail) throw new Error("Não foi possível identificar o usuário.");

    console.log(`💾 Salvando tokens via Callback para: ${userEmail}`);

    const { data, error } = await supabase
      .from('profiles')
      .update({ 
        googleAuth: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiryDate: tokens.expiry_date
        }
      })
      .eq('email', userEmail)
      .select();

    if (error) throw error;

    res.send(`
      <div style="font-family: sans-serif; text-align: center; margin-top: 50px; background: #f9fafb; padding: 40px; border-radius: 20px;">
        <h1 style="color: #059669;">✅ Agenda Conectada!</h1>
        <p style="color: #4b5563;">A Lucy agora já pode organizar seus horários em <b>${userEmail}</b>.</p>
        <p style="font-size: 0.8rem; color: #9ca3af;">Esta aba fechará sozinha em instantes...</p>
        <script>setTimeout(() => window.close(), 3000);</script>
      </div>
    `);

  } catch (error: any) {
    console.error("❌ Erro no Google Callback:", error.message);
    res.status(500).send("Erro ao salvar credenciais da agenda.");
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
