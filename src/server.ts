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

// 1. CORS
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature'],
  credentials: true
}));

// 2. MIDDLEWARES DE PARSING (ESSENCIAL PARA FUNCIONAR OS BOTÕES DE SALVAR)
app.use('/api/stripe', stripeRoutes); // Webhook do Stripe costuma precisar do raw body
app.use(express.json()); // Entende JSON enviado pelo Frontend

// --- ROTAS DE CONFIGURAÇÃO ---

app.post('/api/settings/hours', async (req: Request, res: Response) => {
  const { email, workingHours, serviceDuration } = req.body;
  
  if (!email || !workingHours) {
      return res.status(400).json({ error: "Dados incompletos" });
  }

  try {
    const { error } = await supabase
      .from('profiles')
      .update({ 
        working_hours: workingHours, // O Supabase aceita o objeto direto se a coluna for JSONB
        service_duration: serviceDuration 
      })
      .eq('email', email.toLowerCase().trim());

    if (error) {
        console.error("Erro Supabase:", error);
        return res.status(500).json({ error: error.message });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Erro interno ao salvar horários" });
  }
});

app.post('/api/settings/ai', async (req: Request, res: Response) => {
  const { email, is_ai_enabled } = req.body;
  await supabase.from('profiles').update({ is_ai_enabled }).eq('email', email.toLowerCase().trim());
  res.json({ ok: true });
});

app.post('/api/settings/store', async (req: Request, res: Response) => {
  const { email, storeName } = req.body;
  await supabase.from('profiles').update({ store_name: storeName }).eq('email', email.toLowerCase().trim());
  res.json({ ok: true });
});

// --- ROTA DE PERFIL ---
app.get('/api/user/profile', async (req: Request, res: Response) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email necessário' });

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', String(email).trim().toLowerCase())
    .single();

  if (error || !data) return res.status(404).json({ error: 'Perfil não encontrado' });
  res.json(data);
});

// --- WHATSAPP ---
app.post('/api/whatsapp/qr', (req, res) => {
  const { email } = req.body;
  startWhatsApp(email, res);
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  const { email } = req.body;
  await disconnectWhatsApp(email);
  res.json({ ok: true });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Wagoo Online na porta ${port}`);
  autoReconnectAll().catch(err => console.error("Erro na reconexão:", err));
});
