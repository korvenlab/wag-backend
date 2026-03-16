import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Importação das Rotas e Serviços
import stripeRoutes from './routes/stripe';
import { startWhatsApp, sessions, autoReconnectAll } from './services/whatsapp';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Configuração do Supabase para rotas administrativas
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ==========================================
// 1. WEBHOOK DO STRIPE (DEVE VIR ANTES DO JSON)
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

// Rotas do Stripe
app.use('/api/stripe', stripeRoutes);

// Rota para salvar os horários de funcionamento (JSONB com 3 turnos por dia)
app.post('/api/settings/hours', async (req: Request, res: Response) => {
  const { email, workingHours, serviceDuration } = req.body;

  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });

  try {
    // IMPORTANTE: Verifique se o nome da tabela é 'profiles' ou 'user_profiles'
    const { error } = await supabase
      .from('profiles') 
      .update({ 
        working_hours: workingHours, // Salva o objeto JSONB com todos os dias
        service_duration: serviceDuration 
      })
      .eq('email', email);

    if (error) throw error;

    res.status(200).json({ message: 'Configurações de agenda atualizadas com sucesso.' });
  } catch (error: any) {
    console.error("❌ Erro ao salvar agenda:", error.message);
    res.status(500).json({ error: 'Erro interno ao salvar configurações de horário.' });
  }
});

// Rota para atualizar o botão de IA (On/Off)
app.post('/api/settings/ai', async (req: Request, res: Response) => {
  const { email, aiEnabled } = req.body;
  try {
    await supabase.from('profiles').update({ is_ai_enabled: aiEnabled }).eq('email', email);
    res.status(200).json({ message: 'Configuração de IA atualizada.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar IA.' });
  }
});

// Rota para buscar perfil do usuário (incluindo os novos horários)
app.get('/api/user/profile', async (req: Request, res: Response) => {
  const email = req.query.email as string;
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', email)
    .single();
    
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

  if (sessions[email]) {
    try { sessions[email].ws.close(); } catch (e) {}
    delete sessions[email];
  }

  const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
  const sessionDir = path.join(__dirname, '..', 'auth_info_baileys', safeEmailFolder);
  
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });

  res.status(200).json({ message: 'WhatsApp desconectado.' });
});

// ==========================================
// 5. INICIALIZAÇÃO
// ==========================================
app.get('/ping', (req, res) => res.status(200).send('pong'));
app.get('/', (req, res) => res.send('WAG Backend Online!'));

app.listen(port, () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);

  setTimeout(async () => {
    await autoReconnectAll();
  }, 5000);
});
