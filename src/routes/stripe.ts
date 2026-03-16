import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-01-27' as any,
});

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// ==========================================
// ROTA: Criar Sessão de Checkout
// ==========================================
router.post('/create-checkout-session', async (req: Request, res: Response) => {
  try {
    const { email, priceId, userId } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      customer_email: email,
      client_reference_id: userId, // Importante para o Webhook saber quem pagou
      success_url: `${process.env.FRONTEND_URL}/dashboard?success=true`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
    });

    res.json({ url: session.url });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ROTA: Webhook (Tratado separadamente)
// ==========================================
// Nota: O middleware express.raw é aplicado no server.ts para esta rota específica
router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body, 
      sig, 
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.client_reference_id;
    const stripeCustomerId = session.customer;

    // Atualiza o Supabase liberando o plano
    if (userId) {
      await supabase
        .from('profiles')
        .update({ 
          is_pro: true, 
          stripe_customer_id: stripeCustomerId 
        })
        .eq('id', userId);
      
      console.log(`✅ Assinatura ativada para o usuário: ${userId}`);
    }
  }

  res.json({ received: true });
});

export default router;