import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Importação das Rotas e Serviços
import stripeRoutes from './routes/stripe';
// Adicionada a importação do disconnectWhatsApp
import { startWhatsApp, sessions, autoReconnectAll, disconnectWhatsApp } from './services/whatsapp';

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

// Rota para salvar o Nome da Loja
app.post('/api/settings/store', async (req: Request, res: Response) => {
  const { email, storeName } = req.body;

  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });

  try {
    const { error } = await supabase
      .from('profiles')
      .update({ store_name: storeName })
      .eq('email', email);

    if (error) throw error;

    res.status(200).json({ message: 'Nome da loja atualizado com sucesso.' });
  } catch (error: any) {
    console.error("❌ Erro ao salvar nome da loja:", error.message);
    res.status(500).json({ error: 'Erro ao atualizar nome da loja.' });
  }
});

// Rota para salvar os horários de funcionamento (JSONB)
app.post('/api/settings/hours', async (req: Request, res: Response) => {
  const { email, workingHours, serviceDuration } = req.body;

  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });

  try {
    const { error } = await supabase
      .from('profiles') 
      .update({ 
        working_hours: workingHours,
        service_duration: serviceDuration 
      })
      .eq('email', email);

    if (error) throw error;

    res.status(200).json({ message: 'Configurações de agenda atualizadas.' });
  } catch (error: any) {
    console.error("❌ Erro ao salvar agenda:", error.message);
    res.status(500).json({ error: 'Erro interno ao salvar horários.' });
  }
});

// Rota para atualizar o botão de IA (On/Off)
app.post('/api/settings/ai', async (req: Request, res: Response) => {
  const { email, aiEnabled } = req.body;
  try {
    await supabase.from('profiles').update({ is_ai_enabled: aiEnabled }).eq('email', email);
    res.status(200).json({ message: 'IA atualizada.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar IA.' });
  }
});

// Rota para buscar perfil do usuário
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

  // Limpa sessão antiga antes de gerar novo QR
  const safeEmailFolder = email.replace(/[^a-zA-Z0-9]/g, '_');
  const sessionDir = path.join(__dirname, '..', 'auth_info_baileys', safeEmailFolder);

  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
  if (sessions[email]) {
    try { sessions[email].ws.close(); } catch (e) {}
    delete sessions[email];
  }

  startWhatsApp(email, res);
});

// Rota de Desconexão (Atualizada para usar o serviço centralizado)
app.post('/api/whatsapp/disconnect', async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email obrigatório.' });

  try {
    await disconnectWhatsApp(email);
    res.status(200).json({ message: 'WhatsApp desconectado com sucesso.' });
  } catch (error) {
    console.error("Erro ao desconectar:", error);
    res.status(500).json({ error: 'Erro ao processar desconexão.' });
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
