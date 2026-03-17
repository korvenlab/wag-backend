import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Configuração do Supabase usando SERVICE_ROLE para ignorar RLS
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! 
);

// Middlewares
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Interface para o corpo da requisição
interface SyncRequestBody {
  email: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string | number;
}

// ==========================================
// ROTA DE SINCRONIZAÇÃO (ATUALIZADA)
// ==========================================
app.post('/api/auth/sync', async (req: Request, res: Response) => {
  const { email, accessToken, refreshToken, expiresAt } = req.body as SyncRequestBody;

  console.log("-----------------------------------------");
  console.log("📥 [SYNC] Requisição recebida para:", email);
  
  if (!email || !accessToken) {
    console.error("❌ [SYNC] Dados ausentes na requisição.");
    return res.status(400).json({ error: 'Email ou Token ausentes.' });
  }

  try {
    // Formatação dos dados para o campo JSONB 'googleAuth'
    const googleAuthData = {
      accessToken: accessToken,
      refreshToken: refreshToken || null,
      expiryDate: expiresAt ? Number(expiresAt) * 1000 : null,
      updatedAt: new Date().toISOString()
    };

    console.log("🔄 [SYNC] Tentando Upsert no Supabase...");

    // Executa o UPSERT (Cria se não existe, atualiza se existe)
    const { data, error } = await supabase
      .from('profiles')
      .upsert(
        { 
          email: email.toLowerCase().trim(),
          googleAuth: googleAuthData,
          updated_at: new Date().toISOString()
        }, 
        { onConflict: 'email' }
      )
      .select();

    if (error) {
      console.error("❌ [SUPABASE ERROR]:", error.message);
      console.error("💡 [HINT]:", error.hint);
      return res.status(500).json({ 
        error: error.message, 
        details: error.hint,
        code: error.code 
      });
    }

    console.log(`✅ [SYNC] Sucesso! Perfil de ${email} atualizado.`);
    res.status(200).json({ message: 'Sincronizado com sucesso!', data });

  } catch (error: any) {
    console.error("💥 [SERVER ERROR]:", error.message);
    res.status(500).json({ error: 'Erro interno no servidor de sincronização.' });
  }
});

// Busca de perfil para a Lucy (IA)
app.get('/api/user/profile', async (req: Request, res: Response) => {
  const email = req.query.email as string;
  if (!email) return res.status(400).json({ error: 'Email necessário' });

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', email.toLowerCase().trim())
    .single();

  if (error) {
    console.warn(`⚠️ [PROFILE] Perfil ${email} não encontrado.`);
    return res.status(404).json({ error: 'Não encontrado' });
  }
  
  res.json(data);
});

app.get('/ping', (req, res) => res.send('lucy-online'));

app.listen(port, () => {
  console.log(`🚀 Lucy Backend rodando na porta ${port}`);
  console.log(`🔗 Conectado ao Supabase: ${process.env.SUPABASE_URL}`);
});
