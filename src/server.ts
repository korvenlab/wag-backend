import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Configuração do Supabase
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Middlewares
app.use(cors({
  origin: '*', // Em produção, mude para seu domínio específico
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Interface para tipar o corpo da requisição de sincronização
interface SyncRequestBody {
  email: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string | number;
}

// ==========================================
// ROTA DE SINCRONIZAÇÃO (CORRIGIDA)
// ==========================================
app.post('/api/auth/sync', async (req: Request, res: Response) => {
  const { email, accessToken, refreshToken, expiresAt } = req.body as SyncRequestBody;

  console.log("-----------------------------------------");
  console.log("📥 [SYNC] Recebido para:", email);
  
  if (!email || !accessToken) {
    console.error("❌ [SYNC] Dados ausentes: email ou accessToken.");
    return res.status(400).json({ error: 'Dados incompletos.' });
  }

  try {
    // 1. Verificar se o perfil existe
    const { data: userCheck, error: checkError } = await supabase
      .from('profiles')
      .select('email')
      .eq('email', email)
      .single();

    if (checkError || !userCheck) {
      console.error(`❌ [SYNC] Usuário ${email} não encontrado.`);
      return res.status(404).json({ error: 'Perfil não encontrado.' });
    }

    // 2. Atualizar o campo googleAuth (JSONB)
    const { data, error: updateError } = await supabase
      .from('profiles')
      .update({ 
        googleAuth: {
          accessToken: accessToken,
          refreshToken: refreshToken || null,
          expiryDate: expiresAt ? Number(expiresAt) * 1000 : null,
          updatedAt: new Date().toISOString()
        }
      })
      .eq('email', email)
      .select();

    if (updateError) throw updateError;

    console.log(`✅ [SYNC] Sucesso para: ${email}`);
    res.status(200).json({ message: 'Sincronizado!', data });

  } catch (error: any) {
    console.error("💥 [SYNC] Erro interno:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Outras rotas básicas
app.get('/api/user/profile', async (req: Request, res: Response) => {
  const email = req.query.email as string;
  if (!email) return res.status(400).json({ error: 'Email necessário' });

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', email)
    .single();

  if (error) return res.status(404).json({ error: 'Não encontrado' });
  res.json(data);
});

app.get('/ping', (req, res) => res.send('pong'));

app.listen(port, () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
});
