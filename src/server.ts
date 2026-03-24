import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

import stripeRoutes from './routes/stripe';
import { startWhatsApp, autoReconnectAll, disconnectWhatsApp } from './services/whatsapp';

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

// --- 1. ROTA DE PERFIL (Busca todos os dados da imagem) ---
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

// --- 2. ROTA PARA LIGAR/DESLIGAR IA ---
app.post('/api/settings/ai', async (req: Request, res: Response) => {
  const { email, is_ai_enabled } = req.body;
  if (!email) return res.status(400).json({ error: 'Email necessário' });

  try {
    const { error } = await supabase
      .from('profiles')
      .update({ is_ai_enabled }) 
      .eq('email', email);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar configuração de IA' });
  }
});

// --- 3. ROTA PARA SALVAR AGENDA ---
app.post('/api/settings/hours', async (req: Request, res: Response) => {
  const { email, workingHours, serviceDuration } = req.body;
  if (!email) return res.status(400).json({ error: 'Email necessário' });

  try {
    const { error } = await supabase
      .from('profiles')
      .update({ 
        working_hours: workingHours, 
        service_duration: serviceDuration 
      })
      .eq('email', email);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar agenda' });
  }
});

// --- 4. ROTA PARA ATUALIZAR NOME DA LOJA ---
app.post('/api/settings/store', async (req: Request, res: Response) => {
  const { email, storeName } = req.body;
  if (!email) return res.status(400).json({ error: 'Email necessário' });

  try {
    const { error } = await supabase
      .from('profiles')
      .update({ store_name: storeName })
      .eq('email', email);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar nome da loja' });
  }
});

// --- 5. ROTA DE SYNC (Login) ---
app.post('/api/auth/sync', async (req: Request, res: Response) => {
  const { email, id } = req.body;
  if (!email || !id) return res.status(400).json({ error: 'Dados insuficientes' });

  try {
    const { data, error } = await supabase
      .from('profiles')
      .upsert({ id, email: String(email).trim() }, { onConflict: 'email' })
      .select()
      .single();

    if (error) throw error;
    res.json({ ok: true, user: data });
  } catch (err) {
    res.status(500).json({ error: 'Erro na sincronização' });
  }
});

// --- 6. WHATSAPP ROUTES ---
app.post('/api/whatsapp/qr', (req, res) => {
  const { email } = req.body;
  startWhatsApp(email, res);
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  const { email } = req.body;
  await disconnectWhatsApp(email);
  res.json({ ok: true });
});

app.get('/ping', (req, res) => res.send('pong'));

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Wagoo Online na porta ${port}`);
  autoReconnectAll().catch(err => console.error(err));
});
