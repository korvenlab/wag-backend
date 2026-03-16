import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();
const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, { apiVersion: '2023-10-16' });
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

router.post('/create-checkout-session', async (req: Request, res: Response) => {
  try {
    const { email, userId } = req.body;
    const priceId = process.env.STRIPE_PRICE_ID?.trim();
    const frontendUrl = process.env.FRONTEND_URL?.trim().replace(/\/$/, "");

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      customer_email: email,
      client_reference_id: userId,
      success_url: `${frontendUrl}/dashboard?success=true`,
      cancel_url: `${frontendUrl}/pricing`,
      subscription_data: { metadata: { supabase_user_id: userId } },
    });
    res.json({ url: session.url });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err: any) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id;
      if (userId) {
        // Ao pagar, marca como pago e JÁ LIGA o botão da IA automaticamente
        await supabase
          .from('profiles')
          .update({ has_paid: true, is_ai_enabled: true })
          .eq('id', userId);
      }
      break;
    }

    case 'customer.subscription.deleted':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      if (sub.status === 'canceled' || sub.status === 'unpaid') {
        const userId = sub.metadata.supabase_user_id;
        if (userId) {
          // SE O PAGAMENTO ACABOU: Desliga o 'has_paid' E o botão 'is_ai_enabled'
          await supabase
            .from('profiles')
            .update({ has_paid: false, is_ai_enabled: false })
            .eq('id', userId);
        }
      }
      break;
    }
  }
  res.json({ received: true });
});

export default router;
