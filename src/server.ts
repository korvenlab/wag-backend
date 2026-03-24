import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

// Importação das Rotas e Serviços
import stripeRoutes from './routes/stripe';
import { startWhatsApp, autoReconnectAll, disconnectWhatsApp } from './services/whatsapp';

const app = express();
const port: number = process.env.PORT ? Number(process.env.PORT) : 3000;

// Cliente Supabase com Service Role para ignorar RLS no Backend
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// 1. CORS - Configurado para aceitar seu domínio oficial e Vercel
app.use(cors({
  origin: true, 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature'],
  credentials: true 
}));

// 2. STRIPE WEBHOOKS (Deve vir antes do express.json para não corromper o body)
app.use('/api/stripe', stripeRoutes);

// 3. PARSER JSON
app.use(express.json());

// --- 4. ROTA DE PERFIL (Resolve o erro 404 ao carregar o Dashboard) ---
app.get('/api/user/profile', async (req: Request, res: Response) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email necessário' });

  try {
    const { data, error } = await supabase
      .from('users') 
      .select('*')
      .eq('email', email)
      .single();

    if (error || !data) {
      console.log("⚠️ Usuário não encontrado no banco:", email);
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

// --- 5. ROTA DE SINCRONIZAÇÃO (Chamada no Login do Frontend) ---
app.post('/api/auth/sync', async (req: Request, res: Response) => {
  const { email, id } = req.body; 
  if (!email || !id) return res.status(400).json({ error: 'Dados insuficientes' });

  try {
    // Upsert usando 'id' e 'email' conforme sua tabela do Supabase
    const { data, error } = await supabase
      .from('users')
      .upsert({ 
        id: id, 
        email: email 
      }, { onConflict: 'email' })
      .select()
      .single();

    if (error) {
      console.error("❌ Erro no upsert do Supabase:", error.message);
      throw error;
    }
    
    res.json({ ok: true, user: data });
  } catch (err) {
    console.error("❌ Erro na rota sync:", err);
    res.status(500).json({ error: 'Erro ao sincronizar usuário' });
  }
});

// 6. WHATSAPP ROUTES
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

// 7. STATUS E PING
app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.send('Wagoo Backend Online! 🚀'));

// Inicialização do Servidor
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
  
  // Auto-reconexão assíncrona para não travar o boot
  console.log("🔄 Iniciando auto-reconexão dos bots...");
  autoReconnectAll().catch(err => console.error("Erro no autoReconnect:", err));
});

// Segurança contra quedas (Anti-Crash)
process.on('uncaughtException', (err) => {
  console.error('🛡️ [Anti-Crash] Erro Crítico:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('🛡️ [Anti-Crash] Rejeição Não Tratada:', reason);
});
