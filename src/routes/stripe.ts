import express, { Request, Response } from 'express';
import Stripe from 'stripe';

const router = express.Router();

// Inicializa o Stripe com a chave secreta do seu .env
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: '2025-01-27' as any, // Mantendo a estabilidade da versão
});

// ==========================================
// 1. ROTA PARA CRIAR A SESSÃO DE CHECKOUT
// ==========================================
router.post('/create-checkout-session', async (req: Request, res: Response) => {
  try {
    const { email, userId } = req.body;

    // Buscamos o ID do preço direto do .env do Backend por segurança
    const priceId = process.env.STRIPE_PRICE_ID;

    if (!priceId) {
      console.error("❌ Erro: STRIPE_PRICE_ID não definido no .env do servidor.");
      return res.status(500).json({ error: "Configuração de preço ausente no servidor." });
    }

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
      // O client_reference_id é o que usaremos no Webhook para saber QUEM pagou
      client_reference_id: userId,
      success_url: `${process.env.FRONTEND_URL}/dashboard?success=true`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
      subscription_data: {
        metadata: {
          userId: userId,
        },
      },
    });

    res.json({ url: session.url });
  } catch (error: any) {
    console.error("🔥 Erro ao criar sessão Stripe:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 2. ROTA DE WEBHOOK (RECEBE O AVISO DO STRIPE)
// ==========================================
router.post('/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    // É aqui que o express.raw do server.ts faz a diferença!
    event = stripe.webhooks.constructEvent(req.body, sig as string, webhookSecret as string);
  } catch (err: any) {
    console.error(`❌ Erro de Assinatura Webhook: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Lógica quando o pagamento é concluído com sucesso
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    
    const userId = session.client_reference_id;
    const customerEmail = session.customer_details?.email;

    console.log(`✅ Pagamento confirmado para o usuário: ${userId} (${customerEmail})`);

    // TODO: Aqui você deve atualizar o banco de dados Supabase
    // Exemplo: supabase.from('profiles').update({ is_pro: true }).eq('id', userId)
  }

  res.json({ received: true });
});

export default router;
