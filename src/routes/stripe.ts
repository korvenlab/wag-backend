import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { pushAdminEvent } from '../services/adminEvents';

dotenv.config();
const router = express.Router();

// FEATURE: Escudo de Boot. Evita que o servidor "crashe" se faltarem chaves no Render
const stripeKey = process.env.STRIPE_SECRET_KEY || '';
if (!stripeKey) {
  console.error("⚠️ AVISO: A variável STRIPE_SECRET_KEY não está configurada no Render!");
}

const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// ==========================================
// ROTA 1: CRIAR PAGAMENTO (Exige JSON)
// Caminho Final: /api/stripe/create-checkout-session
// ==========================================
router.post('/create-checkout-session', express.json(), async (req: Request, res: Response) => {
  try {
    const { email, userId } = req.body;
    
    if (!email || !userId) {
       return res.status(400).json({ error: "Email e userId são obrigatórios." });
    }

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
    console.error("❌ Erro ao gerar link de pagamento:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ROTA 2: WEBHOOK DO STRIPE (Exige RAW)
// Caminho Final: /api/stripe/webhook
// ==========================================
router.post('/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  let event: Stripe.Event;

  try {
    // A validação funciona perfeitamente agora porque forçamos o formato RAW apenas nesta rota
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err: any) {
    console.error(`❌ Erro de Assinatura no Webhook: ${err.message}`);
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
        console.log(`✅ Pagamento confirmado para o utilizador: ${userId}`);
        pushAdminEvent('wagoo', 'Pagamento confirmado — assinatura Wagoo ativa', 'online');
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
          console.log(`🛑 Assinatura cancelada/pendente para o utilizador: ${userId}`);
          pushAdminEvent('wagoo', 'Assinatura cancelada ou inadimplente', 'degraded');
        }
      }
      break;
    }
  }
  res.json({ received: true });
});

export default router;
