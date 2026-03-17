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
// 1. STRIPE E WEBHOOKS
// ==========================================
// O webhook do Stripe EXIGE o corpo da requisição "raw" para validar a assinatura
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeRoutes);

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

    // Objeto dinâmico para evitar enviar colunas que não existem (como updated_at)
    const upsertData: any = { 
      email: email.toLowerCase().trim(),
      googleAuth: googleAuthData
    };

    // Se a Vercel mandar o ID do usuário logado, nós salvamos para evitar o erro de "null id"
    if (userId) {
      upsertData.id = userId;
    }

    const { data, error } = await supabase
      .from('profiles')
      .upsert(upsertData, { onConflict: 'email' })
      .select();

    if (error) {
      console.error("❌ [SUPABASE ERROR]:", error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ [SYNC] Sucesso para: ${email}`);
    res.status(200).json({ message: 'Sincronizado.', data });
  } catch (error: any) {
    console.error("❌ [SYNC] Erro:", error.message);
    res.status(500).json
