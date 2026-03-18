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

// Forçando a variável port a ser um número, satisfazendo a exigência do app.listen
const port: number = process.env.PORT ? Number(process.env.PORT) : 3000;

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ==========================================
// 1. CONFIGURAÇÃO DO CORS (O Escudo Global)
// FEATURE: O CORS DEVE SER A PRIMEIRA COISA A CARREGAR!
// ==========================================
app.use(cors({
  origin: true, // Aceita a origem automaticamente (Resolve bloqueios da Vercel)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature'],
  credentials: true 
}));

// ==========================================
// 2. STRIPE E WEBHOOKS
// ==========================================
app.use('/api/stripe', stripeRoutes);

// ==========================================
// 3. PARSER JSON (Para o resto da aplicação)
// ==========================================
app.use(express.json());

// ==========================================
// 4. ROTAS DE INTEGRAÇÃO (GOOGLE AUTH)
// ==========================================

interface SyncRequestBody {
  userId?: string;
  email: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string | number;
}

app.post('/api/auth/sync', async (req: Request, res: Response) => {
  const { userId, email, accessToken, refreshToken, expiresAt } = req.body as SyncRequestBody;

  console.log("-----------------------------------------");
  console.log("📥 [SYNC] Dados recebidos para:", email);

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

    const { data, error } = await supabase
      .from('profiles')
      .update({ googleAuth: googleAuthData })
      .eq('email', email.toLowerCase().trim())
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

    if (!userEmail) {
      return res.status(400).send("Erro: E-mail não pôde ser verificado.");
    }

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

    res.send('<h1>✅ Conectado! Feche esta aba.</h1><script>setTimeout(()=>window.close(),2000)</script>');
  } catch (error: any) {
    console.error("❌ [CALLBACK ERROR]:", error.message);
    res.status(500).send("Erro no callback.");
  }
});

// ==========================================
// 5. CONFIGURAÇÕES DO USUÁRIO & PERFIL
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
  const id = req.query.id as string; 

  if (!email) return res.status(400).json({ error: 'Email necessário' });

  const cleanEmail = email.toLowerCase().trim();

  try {
    const { data: existingProfile, error: fetchError } = await supabase
      .from('profiles')
      .select('*')
      .eq('email', cleanEmail)
      .maybeSingle(); 

    if (fetchError) {
      console.error("❌ Erro ao buscar perfil:", fetchError.message);
      return res.status(500).json({ error: 'Erro no banco de dados' });
    }

    if (existingProfile) {
      return res.json(existingProfile);
    }

    console.log(`⚠️ Perfil de ${cleanEmail} não encontrado. Criando novo...`);
    
    const newProfileData: any = {
      email: cleanEmail,
      has_paid: false,
      is_ai_enabled: false,
      messages_answered: 0,
      appointments_count: 0,
      service_duration: 30
    };

    if (id) {
        newProfileData.id = id;
    }

    const { data: newProfile, error: insertError } = await supabase
      .from('profiles')
      .insert([newProfileData])
      .select('*')
      .single();

    if (insertError) {
      console.error("❌ Erro ao criar perfil padrão:", insertError.message);
      return res.status(500).json({ error: insertError.message });
    }

    console.log(`✅ Perfil padrão criado para: ${cleanEmail}`);
    return res.json(newProfile);

  } catch (error: any) {
    console.error("💥 Erro Inesperado na rota profile:", error.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// ==========================================
// 6. WHATSAPP
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
// 7. BOOT & SISTEMA ANTI-CRASH
// ==========================================
app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('WBOT Backend Online!'));

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
  autoReconnectAll();
});

process.on('uncaughtException', (err) => {
  console.error('🛡️ [Anti-Crash] Erro Crítico Não Capturado:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🛡️ [Anti-Crash] Rejeição de Promessa Não Tratada:', reason);
});
