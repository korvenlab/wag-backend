import express, { Request, Response } from 'express';
import Stripe from 'stripe';

const router = express.Router();

// 1. ALTERAÇÃO AQUI: Removemos a data fixa e deixamos a biblioteca gerenciar
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  // @ts-ignore - Algumas versões de TS pedem o cast, mas deixar vazio pega a versão da conta
});

// ==========================================
// ROTA PARA CRIAR A SESSÃO DE CHECKOUT
// ==========================================
router.post('/create-checkout-session', async (req: Request, res: Response) => {
  try {
    const { email, userId } = req.body;
    const priceId = process.env.STRIPE_PRICE_ID;

    if (!priceId) {
      console.error("❌ Erro: STRIPE_PRICE_ID não definido.");
      return res.status(500).json({ error: "Configuração de preço ausente." });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      customer_email: email,
      client_reference_id: userId,
      success_url: `${process.env.FRONTEND_URL}/dashboard?success=true`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
    });

    res.json({ url: session.url });
  } catch (error: any) {
    console.error("🔥 Erro Stripe:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ROTA DE WEBHOOK
// ==========================================
router.post('/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig as string, webhookSecret as string);
  } catch (err: any) {
    console.error(`❌ Webhook Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    console.log(`✅ Pagamento confirmado para: ${session.client_reference_id}`);
    // Futura integração com Supabase aqui
  }

  res.json({ received: true });
});

export default router;
