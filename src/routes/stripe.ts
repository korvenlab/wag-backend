import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import dotenv from 'dotenv';

// Garante que as variáveis sejam lidas
dotenv.config();

const router = express.Router();

// Inicializa o Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  // @ts-ignore
});

router.post('/create-checkout-session', async (req: Request, res: Response) => {
  try {
    const { email, userId } = req.body;

    // 1. Limpeza rigorosa das variáveis do seu .env
    const priceId = process.env.STRIPE_PRICE_ID?.trim();
    const frontendUrl = process.env.FRONTEND_URL?.trim().replace(/\/$/, ""); // Remove barra no final se houver

    // Log de segurança (aparecerá no log da Render)
    console.log("--- Iniciando Checkout ---");
    console.log("User:", userId);
    console.log("Price ID:", priceId);
    console.log("Frontend URL:", frontendUrl);

    // 2. Verificações de Erro Explícitas
    if (!priceId) {
      return res.status(400).json({ error: "ERRO: STRIPE_PRICE_ID não configurado no .env" });
    }

    if (!frontendUrl || !frontendUrl.startsWith("http")) {
      return res.status(400).json({ error: `ERRO: URL inválida detectada: ${frontendUrl}` });
    }

    // 3. Criação da Sessão
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      customer_email: email,
      client_reference_id: userId,
      // Montagem da URL sem risco de barras duplas
      success_url: `${frontendUrl}/dashboard?success=true`,
      cancel_url: `${frontendUrl}/pricing`,
      subscription_data: {
        metadata: {
          supabase_user_id: userId,
        },
      },
    });

    console.log("✅ Sessão criada com sucesso:", session.id);
    res.json({ url: session.url });

  } catch (error: any) {
    console.error("🔥 Erro Stripe detalhado:", error.message);
    res.status(500).json({ 
      error: "Falha na comunicação com Stripe", 
      message: error.message 
    });
  }
});

// Rota de Webhook (Apenas estrutura para não quebrar)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  res.json({ received: true });
});

export default router;
