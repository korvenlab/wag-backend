import type Stripe from 'stripe';
import { supabase } from '../lib/supabase';
import { stripe, frontendBaseUrl } from '../lib/stripeClient';
import { WAGOO_APPLICATION_FEE_PERCENT, brlToCents } from '../lib/connectFees';
import { log } from '../lib/logger';
import {
  asaasCancelSubscription,
  asaasConfigured,
  asaasCreateCustomer,
  asaasCreateSubscription,
  asaasGetPayment,
  asaasListSubscriptionPayments,
  todayIsoDateSaoPaulo,
  type AsaasPayment,
} from '../lib/asaasClient';
import { creditClubLedgerFromPayment } from '../lib/clubLedger';

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
  asaas_external_ref?: string | null;
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

export function clubPaymentsReady(): boolean {
  return asaasConfigured();
}

/** @deprecated Stripe Connect — mantido só para membros legados. */
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

/** Checkout Asaas: assinatura mensal na conta Wagoo + URL da 1ª fatura. */
export async function createClubAsaasCheckout(opts: {
  plan: ClubPlanRow;
  slug: string;
  storeName: string;
  clientName: string;
  clientPhone: string;
  clientEmail?: string | null;
  memberId: string;
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!asaasConfigured()) {
    return { ok: false, error: 'Pagamentos do clube temporariamente indisponíveis.' };
  }

  const price = Math.round(Number(opts.plan.price_brl) * 100) / 100;
  if (price < 1) return { ok: false, error: 'Valor do clube inválido.' };

  const phone = digitsPhone(opts.clientPhone);
  const externalRef = `club_member:${opts.memberId}`.slice(0, 100);

  const customer = await asaasCreateCustomer({
    name: opts.clientName,
    email: opts.clientEmail,
    mobilePhone: phone,
    externalReference: externalRef,
  });
  if (!customer.ok) return { ok: false, error: customer.error };

  // Cancela assinatura Asaas anterior pendente deste membro (evita duplicar)
  const { data: memberRow } = await supabase
    .from('club_members')
    .select('asaas_subscription_id')
    .eq('id', opts.memberId)
    .maybeSingle();
  if (memberRow?.asaas_subscription_id) {
    await asaasCancelSubscription(String(memberRow.asaas_subscription_id));
  }

  const description = `${opts.plan.name} — ${opts.storeName || 'Salão'}`.slice(0, 400);
  const sub = await asaasCreateSubscription({
    customerId: customer.data.id,
    value: price,
    nextDueDate: todayIsoDateSaoPaulo(),
    description,
    externalReference: externalRef,
    cycle: 'MONTHLY',
  });
  if (!sub.ok) return { ok: false, error: sub.error };

  await supabase
    .from('club_members')
    .update({
      asaas_customer_id: customer.data.id,
      asaas_subscription_id: sub.data.id,
      status: 'pending',
      updated_at: new Date().toISOString(),
    })
    .eq('id', opts.memberId);

  let checkoutUrl =
    (sub.data.paymentLink && String(sub.data.paymentLink)) ||
    '';

  if (!checkoutUrl) {
    // Aguarda fatura da 1ª cobrança
    for (let i = 0; i < 5 && !checkoutUrl; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 400));
      const payments = await asaasListSubscriptionPayments(sub.data.id);
      if (!payments.ok) continue;
      const first = payments.data.find((p) => p.invoiceUrl) || payments.data[0];
      if (first?.invoiceUrl) checkoutUrl = first.invoiceUrl;
    }
  }

  if (!checkoutUrl) {
    const portal = clubClientPortalUrl(opts.slug);
    return {
      ok: false,
      error: `Assinatura criada, mas a fatura ainda não está pronta. Tente de novo em instantes ou abra ${portal}.`,
    };
  }

  return { ok: true, url: checkoutUrl };
}

/** @deprecated Stripe Connect checkout */
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
    log.error('CLUB', 'checkout Stripe falhou', err, { memberId: opts.memberId });
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

function parseClubMemberExternalRef(ref: string | null | undefined): string | null {
  const raw = String(ref || '');
  const m = raw.match(/^club_member:([0-9a-f-]{36})$/i);
  return m?.[1] || null;
}

function periodFromPayment(payment: AsaasPayment): {
  start: string;
  end: string;
} {
  const paidRaw =
    payment.paymentDate || payment.clientPaymentDate || payment.dueDate || null;
  const start = paidRaw ? new Date(`${paidRaw}T12:00:00-03:00`) : new Date();
  if (Number.isNaN(start.getTime())) {
    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + 1);
    return { start: now.toISOString(), end: end.toISOString() };
  }
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Webhook Asaas: pagamento confirmado da assinatura do clube. */
export async function handleAsaasClubPaymentEvent(
  payment: AsaasPayment,
  eventType: string,
): Promise<void> {
  const status = String(payment.status || '').toUpperCase();
  const paidOk =
    status === 'RECEIVED' ||
    status === 'CONFIRMED' ||
    status === 'RECEIVED_IN_CASH';

  if (!paidOk && !/PAYMENT_(RECEIVED|CONFIRMED)/i.test(eventType)) {
    return;
  }

  const memberIdFromRef = parseClubMemberExternalRef(payment.externalReference);
  let memberQuery = supabase
    .from('club_members')
    .select('id, profile_id, club_plan_id, asaas_subscription_id, status');

  if (memberIdFromRef) {
    memberQuery = memberQuery.eq('id', memberIdFromRef);
  } else if (payment.subscription) {
    memberQuery = memberQuery.eq('asaas_subscription_id', payment.subscription);
  } else {
    return;
  }

  const { data: member } = await memberQuery.maybeSingle();
  if (!member?.id || !member.profile_id) {
    log.warn('CLUB', 'pagamento Asaas sem membro', {
      paymentId: payment.id,
      ref: payment.externalReference,
    });
    return;
  }

  const { start, end } = periodFromPayment(payment);

  await supabase
    .from('club_members')
    .update({
      status: 'active',
      asaas_last_payment_id: payment.id,
      asaas_subscription_id: payment.subscription || member.asaas_subscription_id,
      current_period_start: start,
      current_period_end: end,
      updated_at: new Date().toISOString(),
    })
    .eq('id', member.id);

  const gross = Number(payment.value) || 0;
  if (gross > 0) {
    await creditClubLedgerFromPayment({
      profileId: String(member.profile_id),
      clubMemberId: String(member.id),
      grossBrl: gross,
      asaasPaymentId: payment.id,
      description: 'Mensalidade clube (Asaas)',
    });
  }

  log.info('CLUB', 'membro ativado via Asaas', {
    memberId: member.id,
    paymentId: payment.id,
    eventType,
  });
}

/** Resolve payment id do webhook e processa (clube + sinal). */
export async function handleAsaasClubWebhookPayload(payload: {
  event?: string;
  payment?: AsaasPayment;
}): Promise<void> {
  const event = String(payload.event || '');
  let payment = payload.payment;
  if (!payment?.id) return;

  const fresh = await asaasGetPayment(payment.id);
  if (fresh.ok) payment = fresh.data;

  const ref = String(payment.externalReference || '');
  const depositMatch = ref.match(/^booking_deposit:([0-9a-f-]{36})$/i);
  if (depositMatch) {
    const appointmentId = depositMatch[1];
    const status = String(payment.status || '').toUpperCase();
    const paidOk =
      status === 'RECEIVED' ||
      status === 'CONFIRMED' ||
      status === 'RECEIVED_IN_CASH' ||
      /PAYMENT_(RECEIVED|CONFIRMED)/i.test(event);
    if (!paidOk) return;

    const { fulfillBookingDepositPayment } = await import('./bookingPayments');
    await fulfillBookingDepositPayment({
      appointmentId,
      asaasPaymentId: payment.id,
      depositAmountBrl: Number(payment.value) || null,
    });
    return;
  }

  await handleAsaasClubPaymentEvent(payment, event);
}

export { digitsPhone };

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
