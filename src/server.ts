import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

// Importação das Rotas e Serviços
import stripeRoutes from './routes/stripe';
import { startWhatsApp, autoReconnectAll, disconnectWhatsApp } from './services/whatsapp';
import { getTokensFromCode, getUserInfo, generateAuthUrl } from './services/googleAuth'; 

const app = express();
const port: number = process.env.PORT ? Number(process.env.PORT) : 3000;

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// 1. CORS - Essencial para integração com Frontend (Vercel/Netlify)
app.use(cors({
  origin: true, 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature'],
  credentials: true 
}));

// 2. STRIPE WEBHOOKS (Deve vir antes do express.json)
app.use('/api/stripe', stripeRoutes);

// 3. PARSER JSON
app.use(express.json());

// --- ROTAS GOOGLE AUTH, SETTINGS E PROFILE (Mantidas conforme seu original) ---
// [Omitidas aqui para brevidade, mas devem permanecer no seu arquivo]

// 6. WHATSAPP ROUTES
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

// 7. BOOT & SISTEMA ANTI-CRASH (AQUI É ONDE TUDO COMEÇA)
app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('WBOT Backend Online!'));

// Inicialização oficial do Servidor
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
  
  // Feature: Chamada assíncrona para não travar o boot do Express no Render
  console.log("🔄 Iniciando auto-reconexão dos bots...");
  autoReconnectAll().catch(err => console.error("Erro no autoReconnect:", err));
});

// Segurança contra quedas por erros não tratados
process.on('uncaughtException', (err) => {
  console.error('🛡️ [Anti-Crash] Erro Crítico:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('🛡️ [Anti-Crash] Rejeição Não Tratada:', reason);
});
