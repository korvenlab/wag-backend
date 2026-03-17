app.post('/api/auth/sync', async (req: Request, res: Response) => {
  const { email, accessToken, refreshToken, expiresAt } = req.body;

  console.log("-----------------------------------------");
  console.log("📥 [SYNC] Recebido para:", email);
  
  if (!email || !accessToken) {
    console.error("❌ [SYNC] Dados ausentes: email ou accessToken.");
    return res.status(400).json({ error: 'Dados incompletos.' });
  }

  try {
    // 1. Verificamos se o usuário existe antes de atualizar
    const { data: userCheck } = await supabase
      .from('profiles')
      .select('email')
      .eq('email', email)
      .single();

    if (!userCheck) {
      console.error(`❌ [SYNC] Usuário ${email} não encontrado na tabela profiles.`);
      return res.status(404).json({ error: 'Perfil não encontrado no banco.' });
    }

    // 2. Tentamos a atualização
    const { data, error } = await supabase
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

    if (error) {
      console.error("❌ [SYNC] Erro do Supabase ao atualizar:", error.message);
      throw error;
    }

    console.log(`✅ [SYNC] Sucesso! Linhas afetadas:`, data?.length);
    res.status(200).json({ message: 'Sincronizado com sucesso!', data });

  } catch (error: any) {
    console.error("💥 [SYNC] Erro interno:", error.message);
    res.status(500).json({ error: error.message });
  }
});
