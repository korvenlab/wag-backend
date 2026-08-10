import type Stripe from 'stripe';
import { supabase } from '../lib/supabase';
import { stripe, frontendBaseUrl } from '../lib/stripeClient';
import { WAGOO_APPLICATION_FEE_PERCENT, brlToCents } from '../lib/connectFees';
import { log } from '../lib/logger';

export type ClubPlanRow = {
  id: string;
  profile_id: string;
  name: string;
  description: string;
  price_brl: number;
  active: boolean;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  stripe_payment_link_id: string | null;
  payment_link_url: string | null;
};

function digitsPhone(raw: string): string {
  return String(raw || '')
    .replace(/\D/g, '')
    .slice(0, 20);
}

export function clubClientPortalUrl(slug: string): string {
  const base = (frontendBaseUrl() || 'https://wagoobot.com').replace(/\/$/, '');
  return `${base}/a/${encodeURIComponent(slug)}/cliente`;
}

/** Garante Product + Price recorrente + Payment Link na conta Connect. */
export async function ensureClubStripeAssets(opts: {
  plan: ClubPlanRow;
  connectAccountId: string;
  storeName: string;
  slug: string;
}): Promise<{ ok: true; plan: ClubPlanRow } | { ok: false; error: string }> {
  const { connectAccountId, storeName, slug } = opts;
  let plan = { ...opts.plan };
  const priceCents = brlToCents(Number(plan.price_brl));
  if (priceCents < 100) {
    return { ok: false, error: 'Valor mínimo do clube: R$ 1,00.' };
  }

  const stripeOpts = { stripeAccount: connectAccountId };
  const portal = clubClientPortalUrl(slug);

  try {
    let productId = plan.stripe_product_id;
    if (!productId) {
      const product = await stripe.products.create(
        {
          name: `${plan.name} — ${storeName || 'Salão'}`,
          description: plan.description || undefined,
          metadata: {
            wagoo_payment: 'club_membership',
            profile_id: plan.profile_id,
            club_plan_id: plan.id,
          },
        },
        stripeOpts,
      );
      productId = product.id;
    } else {
      await stripe.products.update(
        productId,
        {
          name: `${plan.name} — ${storeName || 'Salão'}`,
          description: plan.description || undefined,
          active: true,
        },
        stripeOpts,
      );
    }

    // Novo Price se valor mudou ou ainda não existe
    let priceId = plan.stripe_price_id;
    let needNewPrice = !priceId;
    if (priceId) {
      try {
        const existing = await stripe.prices.retrieve(priceId, stripeOpts);
        if (existing.unit_amount !== priceCents || existing.recurring?.interval !== 'month') {
          needNewPrice = true;
        }
      } catch {
        needNewPrice = true;
      }
    }

    if (needNewPrice) {
      const price = await stripe.prices.create(
        {
          product: productId,
          currency: 'brl',
          unit_amount: priceCents,
          recurring: { interval: 'month' },
          metadata: {
            wagoo_payment: 'club_membership',
            profile_id: plan.profile_id,
            club_plan_id: plan.id,
          },
        },
        stripeOpts,
      );
      priceId = price.id;
    }

    // Payment Link (cartão, recorrente) — link compartilhável
    let linkId = plan.stripe_payment_link_id;
    let linkUrl = plan.payment_link_url;

    const recreateLink = async () => {
      if (linkId) {
        try {
          await stripe.paymentLinks.update(linkId, { active: false }, stripeOpts);
        } catch {
          /* ignore */
        }
      }
      const link = await stripe.paymentLinks.create(
        {
          line_items: [{ price: priceId!, quantity: 1 }],
          after_completion: {
            type: 'redirect',
            redirect: { url: `${portal}?checkout=success` },
          },
          application_fee_percent: WAGOO_APPLICATION_FEE_PERCENT,
          metadata: {
            wagoo_payment: 'club_membership',
            profile_id: plan.profile_id,
            club_plan_id: plan.id,
          },
          subscription_data: {
            metadata: {
              wagoo_payment: 'club_membership',
              profile_id: plan.profile_id,
              club_plan_id: plan.id,
            },
          },
        },
        stripeOpts,
      );
      linkId = link.id;
      linkUrl = link.url;
    };

    if (!linkId || !linkUrl || needNewPrice) {
      await recreateLink();
    }

    const patch = {
      stripe_product_id: productId,
      stripe_price_id: priceId,
      stripe_payment_link_id: linkId,
      payment_link_url: linkUrl,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('club_plans')
      .update(patch)
      .eq('id', plan.id)
      .select('*')
      .single();

    if (error || !data) {
      return { ok: false, error: error?.message || 'Falha ao salvar plano Stripe.' };
    }

    return { ok: true, plan: data as ClubPlanRow };
  } catch (err) {
    log.error('CLUB', 'ensureClubStripeAssets falhou', err, {
      profileId: plan.profile_id,
      connectAccountId,
    });
    const message = err instanceof Error ? err.message : 'Falha ao criar link Stripe.';
    return { ok: false, error: message };
  }
}

export async function createClubCheckoutSession(opts: {
  plan: ClubPlanRow;
  connectAccountId: string;
  slug: string;
  clientName: string;
  clientPhone: string;
  clientEmail?: string | null;
  memberId: string;
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!opts.plan.stripe_price_id) {
    return { ok: false, error: 'Plano ainda sem preço Stripe. Ative o clube no painel.' };
  }

  const portal = clubClientPortalUrl(opts.slug);
  const phone = digitsPhone(opts.clientPhone);
  const meta = {
    wagoo_payment: 'club_membership',
    profile_id: opts.plan.profile_id,
    club_plan_id: opts.plan.id,
    club_member_id: opts.memberId,
    client_phone: phone,
    client_name: opts.clientName.slice(0, 120),
  };

  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        line_items: [{ price: opts.plan.stripe_price_id, quantity: 1 }],
        payment_method_types: ['card'],
        customer_email: opts.clientEmail?.trim() || undefined,
        client_reference_id: opts.memberId,
        subscription_data: {
          application_fee_percent: WAGOO_APPLICATION_FEE_PERCENT,
          metadata: meta,
        },
        metadata: meta,
        success_url: `${portal}?checkout=success&phone=${encodeURIComponent(phone)}`,
        cancel_url: `${portal}?checkout=cancel&phone=${encodeURIComponent(phone)}`,
        locale: 'pt-BR',
      },
      { stripeAccount: opts.connectAccountId },
    );

    if (!session.url) return { ok: false, error: 'Não foi possível abrir o pagamento.' };
    return { ok: true, url: session.url };
  } catch (err) {
    log.error('CLUB', 'checkout falhou', err, { memberId: opts.memberId });
    const message = err instanceof Error ? err.message : 'Falha no Checkout.';
    return { ok: false, error: message };
  }
}

function statusFromSubscription(sub: Stripe.Subscription): 'active' | 'past_due' | 'canceled' {
  if (sub.status === 'active' || sub.status === 'trialing') return 'active';
  if (sub.status === 'past_due' || sub.status === 'unpaid') return 'past_due';
  return 'canceled';
}

export async function upsertClubMemberFromSubscription(opts: {
  profileId: string;
  clubPlanId?: string | null;
  memberId?: string | null;
  clientName?: string | null;
  clientPhone?: string | null;
  clientEmail?: string | null;
  subscription: Stripe.Subscription;
}): Promise<void> {
  const sub = opts.subscription;
  const status = statusFromSubscription(sub);
  const phone = digitsPhone(opts.clientPhone || sub.metadata?.client_phone || '');
  const periodStart = sub.current_period_start
    ? new Date(sub.current_period_start * 1000).toISOString()
    : null;
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;

  const customerId =
    typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;

  const patch = {
    status,
    stripe_subscription_id: sub.id,
    stripe_customer_id: customerId,
    current_period_start: periodStart,
    current_period_end: periodEnd,
    club_plan_id: opts.clubPlanId || sub.metadata?.club_plan_id || null,
    updated_at: new Date().toISOString(),
  };

  if (opts.memberId) {
    await supabase
      .from('club_members')
      .update({
        ...patch,
        ...(opts.clientName ? { client_name: opts.clientName } : {}),
        ...(opts.clientEmail ? { client_email: opts.clientEmail } : {}),
      })
      .eq('id', opts.memberId)
      .eq('profile_id', opts.profileId);
    return;
  }

  if (phone) {
    const { data: existing } = await supabase
      .from('club_members')
      .select('id')
      .eq('profile_id', opts.profileId)
      .eq('client_phone', phone)
      .maybeSingle();

    if (existing?.id) {
      await supabase
        .from('club_members')
        .update({
          ...patch,
          ...(opts.clientName ? { client_name: opts.clientName } : {}),
          ...(opts.clientEmail ? { client_email: opts.clientEmail } : {}),
        })
        .eq('id', existing.id);
      return;
    }
  }

  await supabase.from('club_members').insert({
    profile_id: opts.profileId,
    client_name: opts.clientName || 'Cliente',
    client_phone: phone || `sub_${sub.id.slice(-12)}`,
    client_email: opts.clientEmail || null,
    ...patch,
  });
}

export async function handleClubCheckoutSession(
  session: Stripe.Checkout.Session,
  connectAccountId?: string | null,
): Promise<void> {
  if (session.metadata?.wagoo_payment !== 'club_membership') return;
  if (session.mode !== 'subscription') return;

  const profileId = session.metadata.profile_id;
  if (!profileId) return;

  const subId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id ?? null;
  if (!subId) return;

  try {
    const stripeOpts = connectAccountId ? { stripeAccount: connectAccountId } : undefined;
    const sub = await stripe.subscriptions.retrieve(subId, stripeOpts);
    await upsertClubMemberFromSubscription({
      profileId,
      clubPlanId: session.metadata.club_plan_id,
      memberId: session.metadata.club_member_id || session.client_reference_id,
      clientName: session.metadata.client_name,
      clientPhone: session.metadata.client_phone,
      clientEmail: session.customer_details?.email || session.customer_email,
      subscription: sub,
    });
  } catch (err) {
    log.error('CLUB', 'handleClubCheckoutSession falhou', err, { sessionId: session.id });
  }
}

export async function handleClubSubscriptionEvent(
  sub: Stripe.Subscription,
): Promise<void> {
  if (sub.metadata?.wagoo_payment !== 'club_membership') return;
  const profileId = sub.metadata.profile_id;
  if (!profileId) return;

  await upsertClubMemberFromSubscription({
    profileId,
    clubPlanId: sub.metadata.club_plan_id,
    memberId: sub.metadata.club_member_id,
    clientName: sub.metadata.client_name,
    clientPhone: sub.metadata.client_phone,
    subscription: sub,
  });
}

export { digitsPhone };

/**
 * Membro com assinatura ativa (e período ainda válido).
 * Usado para liberar agendamento sem sinal no WhatsApp e na Agenda Web.
 */
function phoneLookupVariants(raw: string): string[] {
  const d = digitsPhone(raw);
  if (!d) return [];
  const set = new Set<string>([d]);
  if (d.startsWith('55') && d.length >= 12) set.add(d.slice(2));
  else if (d.length === 10 || d.length === 11) set.add(`55${d}`);
  return [...set];
}

export async function findActiveClubMemberByPhone(
  profileId: string,
  rawPhone: string,
): Promise<{
  id: string;
  client_name: string;
  client_phone: string;
  current_period_end: string | null;
  days_left: number | null;
} | null> {
  const variants = phoneLookupVariants(rawPhone);
  if (!variants.length || variants[0].length < 10) return null;

  const { data } = await supabase
    .from('club_members')
    .select('id, client_name, client_phone, status, current_period_end')
    .eq('profile_id', profileId)
    .in('client_phone', variants)
    .eq('status', 'active')
    .maybeSingle();

  if (!data) return null;

  const end = data.current_period_end ? new Date(data.current_period_end) : null;
  if (end && !Number.isNaN(end.getTime()) && end.getTime() < Date.now()) {
    // Período vencido — marca past_due leve (não cancela assinatura Stripe aqui)
    await supabase
      .from('club_members')
      .update({ status: 'past_due', updated_at: new Date().toISOString() })
      .eq('id', data.id);
    return null;
  }

  let days_left: number | null = null;
  if (end && !Number.isNaN(end.getTime())) {
    days_left = Math.max(
      0,
      Math.ceil((end.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
    );
  }

  return {
    id: String(data.id),
    client_name: String(data.client_name),
    client_phone: String(data.client_phone),
    current_period_end: data.current_period_end
      ? String(data.current_period_end)
      : null,
    days_left,
  };
}

