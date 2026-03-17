import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // IMPORTANTE: Use a Service Role para ignorar RLS no backend
);

app.use(cors({ origin: '*' }));
app.use(express.json());

interface SyncRequestBody {
  email: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string | number;
}

app.post('/api/auth/sync', async (req: Request, res: Response) => {
  const { email, accessToken, refreshToken, expiresAt } = req.body as SyncRequestBody;

  console.log("-----------------------------------------");
  console.log("📥 [SYNC] Tentando sincronizar:", email);
  
  if (!email || !accessToken) {
    return res.status(400).json({ error: 'Dados incompletos.' });
  }

  try {
    // FORMATANDO OS DADOS
    const googleAuthData = {
      accessToken: accessToken,
      refreshToken: refreshToken || null,
      expiryDate: expiresAt ? Number(expiresAt) * 1000 : null,
      updatedAt: new Date().toISOString()
    };

    // UPSERT: Se existir o email, atualiza. Se não, insere.
    // Isso evita o erro de "Perfil não encontrado"
    const { data, error } = await supabase
      .from('profiles')
      .upsert(
        { 
          email: email.toLowerCase(), // Forçamos minúsculo para evitar erro de busca
          googleAuth: googleAuthData,
          updated_at: new Date().toISOString()
        }, 
        { onConflict: 'email' } // Diz ao banco para usar o email como critério de conflito
      )
      .select();

    if (error) {
      console.error("❌ [SUPABASE ERROR]:", error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ [SYNC] Sucesso total para: ${email}`);
    res.status(200).json({ message: 'Sincronizado com sucesso!', data });

  } catch (error: any) {
    console.error("💥 [SERVER ERROR]:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/user/profile', async (req: Request, res: Response) => {
  const email = req.query.email as string;
  if (!email) return res.status(400).json({ error: 'Email necessário' });

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', email.toLowerCase())
    .single();

  if (error) return res.status(404).json({ error: 'Não encontrado' });
  res.json(data);
});

app.get('/ping', (req, res) => res.send('lucy-online'));

app.listen(port, () => {
  console.log(`🚀 Lucy Backend rodando na porta ${port}`);
});
