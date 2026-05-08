import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { pushAdminEvent } from '../services/adminEvents';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';

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
    const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
    if (!auth.ok) {
      return res.status(401).json({
        error:
          auth.reason === 'missing_token'
            ? 'Faça login e envie Authorization: Bearer (access_token).'
            : 'Sessão inválida ou expirada.',
      });
    }

    const { email, userId } = req.body;

    if (!email || !userId) {
       return res.status(400).json({ error: "Email e userId são obrigatórios." });
    }

    const emailNorm = String(email).trim().toLowerCase();
    if (auth.user.id !== userId || auth.user.email?.toLowerCase() !== emailNorm) {
      return res.status(403).json({ error: 'Os dados não coincidem com o usuário logado.' });
    }

    const priceId = process.env.STRIPE_PRICE_ID?.trim();
    const frontendUrl = process.env.FRONTEND_URL?.trim().replace(/\/$/, "");

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      customer_email: emailNorm,
      client_reference_id: userId,
      success_url: `${frontendUrl}/dashboard?checkout=success`,
      cancel_url: `${frontendUrl}/?checkout=canceled#precos`,
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
      let userId = session.client_reference_id ?? null;
      /** Fallback: metadata na Subscription quando client_reference_id falha em retries. */
      if (!userId && typeof session.subscription === 'string') {
        try {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          userId = sub.metadata?.supabase_user_id ?? null;
        } catch (e) {
          console.error('[stripe webhook] checkout.session.completed retrieve subscription:', e);
        }
      }
      if (userId) {
        await supabase
          .from('profiles')
          .update({ has_paid: true, is_ai_enabled: true })
          .eq('id', userId);
        console.log(`✅ Pagamento confirmado para o utilizador: ${userId}`);
        pushAdminEvent('wagoo', 'Pagamento confirmado — assinatura Wagoo ativa', 'online');
      }
      break;
    }

    /** Antes só checkout marcava pago; assinatura `active` sem esse evento deixava Korven em “não pago”. */
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const userId = sub.metadata?.supabase_user_id;
      if (!userId) break;
      if (sub.status === 'active' || sub.status === 'trialing') {
        await supabase
          .from('profiles')
          .update({ has_paid: true, is_ai_enabled: true })
          .eq('id', userId);
        console.log(`✅ Assinatura ${sub.status} — has_paid=true: ${userId}`);
      } else if (
        sub.status === 'canceled' ||
        sub.status === 'unpaid' ||
        sub.status === 'incomplete_expired'
      ) {
        await supabase
          .from('profiles')
          .update({ has_paid: false, is_ai_enabled: false })
          .eq('id', userId);
        console.log(`🛑 Assinatura ${sub.status} — has_paid=false: ${userId}`);
        pushAdminEvent('wagoo', 'Assinatura cancelada ou inadimplente', 'degraded');
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const userId = sub.metadata?.supabase_user_id;
      if (userId) {
        await supabase
          .from('profiles')
          .update({ has_paid: false, is_ai_enabled: false })
          .eq('id', userId);
        console.log(`🛑 Subscription deleted — has_paid=false: ${userId}`);
        pushAdminEvent('wagoo', 'Assinatura removida', 'degraded');
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      const inv = event.data.object as Stripe.Invoice;
      const subId =
        typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id ?? null;
      if (!subId) break;
      try {
        const sub = await stripe.subscriptions.retrieve(subId);
        const userId = sub.metadata?.supabase_user_id;
        if (userId && (sub.status === 'active' || sub.status === 'trialing')) {
          await supabase
            .from('profiles')
            .update({ has_paid: true, is_ai_enabled: true })
            .eq('id', userId);
          console.log(`✅ invoice.payment_succeeded — has_paid=true: ${userId}`);
        }
      } catch (e) {
        console.error('[stripe webhook] invoice.payment_succeeded:', e);
      }
      break;
    }
  }
  res.json({ received: true });
});

export default router;
