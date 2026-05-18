import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import { pushAdminEvent } from '../services/adminEvents';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { setProfileHasPaidByUserId } from '../lib/profileHasPaid';
import { setProfileMultiBarberPlanByUserId } from '../lib/setMultiBarberPlan';
import { supabase } from '../lib/supabase';

function isMultiBarberSubscription(sub: Stripe.Subscription): boolean {
  return sub.metadata?.plan_type === 'multi_barber';
}

async function applySubscriptionPlanFlags(sub: Stripe.Subscription): Promise<void> {
  const userId = sub.metadata?.supabase_user_id;
  if (!userId) return;

  const active = sub.status === 'active' || sub.status === 'trialing';

  if (isMultiBarberSubscription(sub)) {
    const r = await setProfileMultiBarberPlanByUserId(supabase, userId, active);
    if (!r.ok) {
      console.error('[stripe webhook] multi_barber_plan:', r.error);
    } else {
      console.log(`✅ multi_barber_plan=${active} — ${userId}`);
    }
    return;
  }

  if (active) {
    const r = await setProfileHasPaidByUserId(supabase, userId, true);
    if (!r.ok) console.error('[stripe webhook] has_paid (active):', r.error);
    else console.log(`✅ has_paid=true — ${userId}`);
  } else if (
    sub.status === 'canceled' ||
    sub.status === 'unpaid' ||
    sub.status === 'incomplete_expired'
  ) {
    const r = await setProfileHasPaidByUserId(supabase, userId, false);
    if (!r.ok) console.error('[stripe webhook] has_paid (inactive):', r.error);
    else console.log(`🛑 has_paid=false — ${userId}`);
    pushAdminEvent('wagoo', 'Assinatura cancelada ou inadimplente', 'degraded');
  }
}

dotenv.config();
const router = express.Router();

// FEATURE: Escudo de Boot. Evita que o servidor "crashe" se faltarem chaves no Render
const stripeKey = process.env.STRIPE_SECRET_KEY || '';
if (!stripeKey) {
  console.error("⚠️ AVISO: A variável STRIPE_SECRET_KEY não está configurada no Render!");
}

const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });

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

// Plano Multi-Barbeiro (add-on premium)
router.post('/create-multi-barber-checkout-session', express.json(), async (req: Request, res: Response) => {
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
      return res.status(400).json({ error: 'Email e userId são obrigatórios.' });
    }

    const emailNorm = String(email).trim().toLowerCase();
    if (auth.user.id !== userId || auth.user.email?.toLowerCase() !== emailNorm) {
      return res.status(403).json({ error: 'Os dados não coincidem com o usuário logado.' });
    }

    const priceId = process.env.STRIPE_MULTI_BARBER_PRICE_ID?.trim();
    if (!priceId) {
      return res.status(503).json({ error: 'Plano Multi-Barbeiro não configurado no servidor.' });
    }

    const frontendUrl = process.env.FRONTEND_URL?.trim().replace(/\/$/, '');

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      customer_email: emailNorm,
      client_reference_id: userId,
      success_url: `${frontendUrl}/dashboard/equipe?checkout=multi_barber_success`,
      cancel_url: `${frontendUrl}/dashboard/equipe?checkout=canceled`,
      subscription_data: {
        metadata: { supabase_user_id: userId, plan_type: 'multi_barber' },
      },
    });

    res.json({ url: session.url });
  } catch (error: any) {
    console.error('❌ Erro checkout Multi-Barbeiro:', error.message);
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
        let handled = false;
        if (typeof session.subscription === 'string') {
          try {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            if (isMultiBarberSubscription(sub)) {
              const r = await setProfileMultiBarberPlanByUserId(supabase, userId, true);
              if (!r.ok) console.error('[stripe webhook] multi_barber checkout:', r.error);
              else console.log(`✅ Plano Multi-Barbeiro ativado: ${userId}`);
              handled = true;
            }
          } catch (e) {
            console.error('[stripe webhook] checkout retrieve subscription:', e);
          }
        }
        if (!handled) {
          const r = await setProfileHasPaidByUserId(supabase, userId, true);
          if (!r.ok) console.error('[stripe webhook] checkout.session.completed profiles:', r.error);
          else console.log(`✅ Pagamento confirmado para o utilizador: ${userId}`);
          pushAdminEvent('wagoo', 'Pagamento confirmado — assinatura Wagoo ativa', 'online');
        }
      }
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      await applySubscriptionPlanFlags(sub);
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const userId = sub.metadata?.supabase_user_id;
      if (!userId) break;
      if (isMultiBarberSubscription(sub)) {
        const r = await setProfileMultiBarberPlanByUserId(supabase, userId, false);
        if (!r.ok) console.error('[stripe webhook] multi_barber deleted:', r.error);
        else console.log(`🛑 multi_barber_plan=false: ${userId}`);
      } else {
        const r = await setProfileHasPaidByUserId(supabase, userId, false);
        if (!r.ok) console.error('[stripe webhook] customer.subscription.deleted:', r.error);
        else console.log(`🛑 Subscription deleted — has_paid=false: ${userId}`);
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
        if (sub.status === 'active' || sub.status === 'trialing') {
          await applySubscriptionPlanFlags(sub);
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
