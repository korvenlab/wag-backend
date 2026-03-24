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

// --- ROTA DE PERFIL (Apontando para 'profiles') ---
app.get('/api/user/profile', async (req: Request, res: Response) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email necessário' });

  try {
    console.log(`🔍 Buscando na tabela profiles: [${email}]`);

    const { data, error } = await supabase
      .from('profiles') // Ajustado para o nome correto da sua tabela
      .select('*')
      .eq('email', String(email).trim())
      .single();

    if (error) {
      console.error("❌ Erro Supabase:", error.message);
      return res.status(404).json({ error: 'Perfil não encontrado', details: error.message });
    }
    
    console.log("✅ Perfil carregado com sucesso!");
    res.json(data);
  } catch (err) {
    console.error("🔥 Erro interno:", err);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

// --- ROTA DE SYNC (Apontando para 'profiles') ---
app.post('/api/auth/sync', async (req: Request, res: Response) => {
  const { email, id } = req.body; 
  if (!email || !id) return res.status(400).json({ error: 'Dados insuficientes' });

  try {
    const { data, error } = await supabase
      .from('profiles') // Ajustado para profiles
      .upsert({ id, email: String(email).trim() }, { onConflict: 'email' })
      .select()
      .single();

    if (error) throw error;
    res.json({ ok: true, user: data });
  } catch (err) {
    console.error("❌ Erro na sincronização:", err);
    res.status(500).json({ error: 'Erro ao sincronizar perfil' });
  }
});

app.post('/api/whatsapp/qr', async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email necessário' });
  startWhatsApp(email, res);
});

app.post('/api/whatsapp/disconnect', async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email necessário' });
  await disconnectWhatsApp(email);
  res.json({ ok: true });
});

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('Wagoo Backend Online! 🚀'));

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
  autoReconnectAll().catch(err => console.error("Erro no autoReconnect:", err));
});

process.on('uncaughtException', (err) => console.error('🛡️ Anti-Crash:', err.message));
process.on('unhandledRejection', (reason) => console.error('🛡️ Anti-Crash:', reason));
