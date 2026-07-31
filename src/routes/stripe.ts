import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import { pushAdminEvent } from '../services/adminEvents';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { setProfileHasPaidByUserId } from '../lib/profileHasPaid';
import { setProfileSubscriptionTierByUserId } from '../lib/setSubscriptionTier';
import { supabase } from '../lib/supabase';
import {
  normalizeSubscriptionTier,
  parsePlanTierFromStripeMetadata,
  resolveStripePriceId,
  WAGOO_PLANS,
  type WagooSubscriptionTier,
} from '../lib/wagooSubscription';

dotenv.config();
const router = express.Router();

const stripeKey = process.env.STRIPE_SECRET_KEY || '';
if (!stripeKey) {
  console.error('⚠️ AVISO: A variável STRIPE_SECRET_KEY não está configurada no Render!');
}

const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });

async function applySubscriptionFromStripe(sub: Stripe.Subscription): Promise<void> {
  const userId = sub.metadata?.supabase_user_id;
  if (!userId) return;

  const active = sub.status === 'active' || sub.status === 'trialing';
  const tier = parsePlanTierFromStripeMetadata(sub.metadata as Record<string, string>);

  if (!active) {
    if (
      sub.status === 'canceled' ||
      sub.status === 'unpaid' ||
      sub.status === 'incomplete_expired'
    ) {
      const r = await setProfileSubscriptionTierByUserId(supabase, userId, null);
      if (!r.ok) console.error('[stripe webhook] tier clear:', r.error);
      else {
        console.log(`🛑 subscription_tier=null — ${userId}`);
        pushAdminEvent('wagoo', 'Assinatura cancelada ou inadimplente', 'degraded');
      }
    }
    return;
  }

  if (tier) {
    const r = await setProfileSubscriptionTierByUserId(supabase, userId, tier);
    if (!r.ok) console.error('[stripe webhook] subscription_tier:', r.error);
    else console.log(`✅ subscription_tier=${tier} — ${userId}`);
    return;
  }

  // Legado: sem plan_tier no metadata
  const r = await setProfileHasPaidByUserId(supabase, userId, true);
  if (!r.ok) console.error('[stripe webhook] has_paid (legacy):', r.error);
  else console.log(`✅ has_paid=true (legado) — ${userId}`);
}

async function createCheckoutForTier(req: Request, res: Response, defaultTier: WagooSubscriptionTier) {
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

    const { email, userId, planTier, plan_tier } = req.body;
    const tierRaw = planTier ?? plan_tier ?? defaultTier;
    const tier = normalizeSubscriptionTier(tierRaw);

    if (!email || !userId) {
      return res.status(400).json({ error: 'Email e userId são obrigatórios.' });
    }
    if (!tier) {
      return res.status(400).json({
        error: 'planTier inválido. Use: agenda_web, basic, pro ou pro_plus.',
      });
    }

    const emailNorm = String(email).trim().toLowerCase();
    if (auth.user.id !== userId || auth.user.email?.toLowerCase() !== emailNorm) {
      return res.status(403).json({ error: 'Os dados não coincidem com o usuário logado.' });
    }

    const priceId = resolveStripePriceId(tier);
    if (!priceId) {
      return res.status(503).json({
        error: `Preço Stripe não configurado para o plano ${WAGOO_PLANS[tier].label}.`,
      });
    }

    const frontendUrl = process.env.FRONTEND_URL?.trim().replace(/\/$/, '');
    const successPath =
      tier === 'agenda_web'
        ? '/dashboard/agenda-web?checkout=success'
        : tier === 'basic'
          ? '/dashboard?checkout=success'
          : '/dashboard/equipe?checkout=success';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      customer_email: emailNorm,
      client_reference_id: userId,
      success_url: `${frontendUrl}${successPath}&plan=${tier}`,
      cancel_url: `${frontendUrl}/?checkout=canceled#precos`,
      subscription_data: {
        metadata: {
          supabase_user_id: userId,
          plan_tier: tier,
        },
      },
    });
    res.json({ url: session.url, planTier: tier });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('❌ Erro ao gerar link de pagamento:', message);
    res.status(500).json({ error: message });
  }
}

router.post('/create-checkout-session', express.json(), (req, res) =>
  createCheckoutForTier(req, res, 'basic'),
);

/** Retrocompat: checkout antigo do add-on → Plano Pro */
router.post('/create-multi-barber-checkout-session', express.json(), (req, res) =>
  createCheckoutForTier(req, res, 'pro'),
);

/** Localiza o customer Stripe do usuário (metadata da assinatura ou e-mail do checkout). */
async function resolveStripeCustomerId(userId: string, email: string): Promise<string | null> {
  try {
    const found = await stripe.subscriptions.search({
      query: `metadata['supabase_user_id']:'${userId}'`,
      limit: 5,
    });
    for (const sub of found.data) {
      if (typeof sub.customer === 'string') return sub.customer;
      if (sub.customer && typeof sub.customer === 'object' && 'id' in sub.customer) {
        return (sub.customer as Stripe.Customer).id;
      }
    }
  } catch (e) {
    console.warn('[stripe portal] subscriptions.search indisponível, tentando por e-mail:', e);
  }

  const customers = await stripe.customers.list({ email, limit: 10 });
  for (const customer of customers.data) {
    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all',
      limit: 1,
    });
    if (subs.data.length > 0) return customer.id;
  }

  return customers.data[0]?.id ?? null;
}

/**
 * Customer Portal da Stripe — cancelar assinatura, trocar cartão, etc.
 * Requer Portal activo no Dashboard Stripe (Settings → Billing → Customer portal).
 */
router.post('/create-billing-portal-session', express.json(), async (req: Request, res: Response) => {
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

    const emailNorm = String(auth.user.email ?? '').trim().toLowerCase();
    if (!emailNorm) {
      return res.status(400).json({ error: 'Conta sem e-mail. Faça login com Google novamente.' });
    }

    const customerId = await resolveStripeCustomerId(auth.user.id, emailNorm);
    if (!customerId) {
      return res.status(404).json({
        error: 'Não encontramos uma assinatura Stripe ligada a esta conta.',
      });
    }

    const frontendUrl = process.env.FRONTEND_URL?.trim().replace(/\/$/, '');
    if (!frontendUrl) {
      return res.status(503).json({ error: 'FRONTEND_URL não configurada no servidor.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${frontendUrl}/dashboard`,
    });

    res.json({ url: session.url });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('❌ Erro ao abrir portal de assinatura:', message);
    res.status(500).json({ error: message });
  }
});

router.post('/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ Erro de Assinatura no Webhook: ${message}`);
    return res.status(400).send(`Webhook Error: ${message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      let userId = session.client_reference_id ?? null;
      let tier: WagooSubscriptionTier | null = null;

      if (typeof session.subscription === 'string') {
        try {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          userId = userId ?? sub.metadata?.supabase_user_id ?? null;
          tier = parsePlanTierFromStripeMetadata(sub.metadata as Record<string, string>);
        } catch (e) {
          console.error('[stripe webhook] checkout.session.completed retrieve subscription:', e);
        }
      }

      if (userId && tier) {
        const r = await setProfileSubscriptionTierByUserId(supabase, userId, tier);
        if (!r.ok) console.error('[stripe webhook] checkout tier:', r.error);
        else {
          console.log(`✅ Plano ${tier} ativado: ${userId}`);
          pushAdminEvent('wagoo', `Pagamento confirmado — ${WAGOO_PLANS[tier].label}`, 'online');
        }
      } else if (userId) {
        const r = await setProfileHasPaidByUserId(supabase, userId, true);
        if (!r.ok) console.error('[stripe webhook] checkout.session.completed profiles:', r.error);
        else console.log(`✅ Pagamento confirmado (legado): ${userId}`);
        pushAdminEvent('wagoo', 'Pagamento confirmado — assinatura Wagoo ativa', 'online');
      }
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      await applySubscriptionFromStripe(sub);
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const userId = sub.metadata?.supabase_user_id;
      if (!userId) break;
      const r = await setProfileSubscriptionTierByUserId(supabase, userId, null);
      if (!r.ok) console.error('[stripe webhook] customer.subscription.deleted:', r.error);
      else console.log(`🛑 subscription removida — ${userId}`);
      pushAdminEvent('wagoo', 'Assinatura removida', 'degraded');
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
          await applySubscriptionFromStripe(sub);
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
