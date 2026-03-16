import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Serviços
import stripeRoutes from './routes/stripe';
import { startWhatsApp, sessions } from './services/whatsapp';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// 1. Webhook Stripe (Raw)
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeRoutes);

// 2. Middlewares
app.use(cors({
  origin: ['https://wagbot.vercel.app', 'http://localhost:5173'], // Simplificado para o exemplo
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// 3. Rotas de Negócio
app.use('/api/stripe', stripeRoutes);

app.get('/ping', (req, res) => res.status(200).send('pong'));

app.post('/api/whatsapp/qr', async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });
  
  const sessionDir = path.join(__dirname, '..', 'auth_info_baileys', email.replace(/[^a-zA-Z0-9]/g, '_'));
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
  if (sessions[email]) { sessions[email].ws.close(); delete sessions[email]; }

  startWhatsApp(email, res);
});

app.post('/api/whatsapp/disconnect', async (req: Request, res: Response) => {
  const { email } = req.body;
  if (sessions[email]) { sessions[email].ws.close(); delete sessions[email]; }
  res.status(200).json({ message: 'Desconectado.' });
});

app.post('/api/settings/ai', async (req: Request, res: Response) => {
  const { email, aiEnabled } = req.body;
  await supabase.from('profiles').update({ is_ai_enabled: aiEnabled }).eq('email', email);
  res.status(200).json({ message: 'OK' });
});

app.get('/api/user/profile', async (req: Request, res: Response) => {
  const email = req.query.email as string;
  const { data } = await supabase.from('profiles').select('*').eq('email', email).single();
  res.status(200).json(data);
});

app.get('/', (req, res) => res.send('WBOT Online!'));

app.listen(port, () => console.log(`🚀 Servidor rodando na porta ${port}`));
