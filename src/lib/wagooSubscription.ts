export type WagooSubscriptionTier = 'agenda_web' | 'basic' | 'pro' | 'pro_plus';

export const WAGOO_TIERS: WagooSubscriptionTier[] = [
  'agenda_web',
  'basic',
  'pro',
  'pro_plus',
];

export type WagooPlanDefinition = {
  tier: WagooSubscriptionTier;
  label: string;
  priceBrl: number;
  maxTeamUsers: number;
  stripePriceEnvKey: string;
};

/** `maxTeamUsers` = limite de profissionais na equipe (`barbeiros`). */
export const WAGOO_PLANS: Record<WagooSubscriptionTier, WagooPlanDefinition> = {
  agenda_web: {
    tier: 'agenda_web',
    label: 'Agenda Web',
    priceBrl: 20,
    maxTeamUsers: 1,
    stripePriceEnvKey: 'STRIPE_PRICE_ID_AGENDA_WEB',
  },
  basic: {
    tier: 'basic',
    label: 'Basic',
    priceBrl: 59,
    maxTeamUsers: 1,
    stripePriceEnvKey: 'STRIPE_PRICE_ID_BASIC',
  },
  pro: {
    tier: 'pro',
    label: 'Pro',
    priceBrl: 149,
    maxTeamUsers: 3,
    stripePriceEnvKey: 'STRIPE_PRICE_ID_PRO',
  },
  pro_plus: {
    tier: 'pro_plus',
    label: 'Pro+',
    priceBrl: 259,
    maxTeamUsers: 5,
    stripePriceEnvKey: 'STRIPE_PRICE_ID_PRO_PLUS',
  },
};

export function normalizeSubscriptionTier(raw: unknown): WagooSubscriptionTier | null {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toLowerCase().replace(/-/g, '_');
  if (s === 'agenda_web' || s === 'agendaweb' || s === 'agenda') return 'agenda_web';
  if (s === 'proplus' || s === 'pro_plus' || s === 'pro+') return 'pro_plus';
  if (s === 'pro') return 'pro';
  if (s === 'basic') return 'basic';
  return null;
}

export function tierFromLegacyProfile(input: {
  subscription_tier?: unknown;
  has_paid?: unknown;
  multi_barber_plan?: unknown;
}): WagooSubscriptionTier | null {
  const explicit = normalizeSubscriptionTier(input.subscription_tier);
  if (explicit) return explicit;

  const paid =
    input.has_paid === true ||
    input.has_paid === 1 ||
    String(input.has_paid ?? '').toLowerCase() === 'true';

  if (!paid) return null;

  const multi =
    input.multi_barber_plan === true ||
    input.multi_barber_plan === 1 ||
    String(input.multi_barber_plan ?? '').toLowerCase() === 'true';

  return multi ? 'pro' : 'basic';
}

export function getMaxTeamUsers(tier: WagooSubscriptionTier | null): number {
  if (!tier) return 0;
  return WAGOO_PLANS[tier].maxTeamUsers;
}

/** Máximo de linhas em `barbeiros` conforme o plano contratado. */
export function getMaxBarbeirosSlots(tier: WagooSubscriptionTier | null): number {
  return getMaxTeamUsers(tier);
}

export function canManageTeam(tier: WagooSubscriptionTier | null): boolean {
  return tier === 'pro' || tier === 'pro_plus';
}

export function tierSupportsMultiBarberAi(tier: WagooSubscriptionTier | null): boolean {
  return getMaxBarbeirosSlots(tier) > 1;
}

/**
 * Lembretes WhatsApp (script, sem IA) — Agenda Web + Pro + Pro+.
 * Basic fica de fora (upsell).
 */
export function tierSupportsReminders(tier: WagooSubscriptionTier | null): boolean {
  return tier === 'agenda_web' || tier === 'pro' || tier === 'pro_plus';
}

/** Export CSV de agendamentos (analytics) — só Pro e Pro+. */
export function tierSupportsCsvExport(tier: WagooSubscriptionTier | null): boolean {
  return tier === 'pro' || tier === 'pro_plus';
}

/** Site público de agendamento — Agenda Web standalone OU planos com IA (Basic/Pro/Pro+). */
export function tierSupportsPublicBooking(tier: WagooSubscriptionTier | null): boolean {
  return (
    tier === 'agenda_web' ||
    tier === 'basic' ||
    tier === 'pro' ||
    tier === 'pro_plus'
  );
}

/** Assinatura só Agenda Web (sem dashboard de IA). */
export function tierIsAgendaWebOnly(tier: WagooSubscriptionTier | null): boolean {
  return tier === 'agenda_web';
}

/** WhatsApp + IA + Google Calendar — planos Basic / Pro / Pro+. */
export function tierSupportsAi(tier: WagooSubscriptionTier | null): boolean {
  return tier === 'basic' || tier === 'pro' || tier === 'pro_plus';
}

export function syncLegacyFlagsFromTier(tier: WagooSubscriptionTier | null): {
  has_paid: boolean;
  multi_barber_plan: boolean;
} {
  if (!tier) {
    return { has_paid: false, multi_barber_plan: false };
  }
  return {
    has_paid: true,
    multi_barber_plan: canManageTeam(tier),
  };
}

export function resolveStripePriceId(tier: WagooSubscriptionTier): string | null {
  const key = WAGOO_PLANS[tier].stripePriceEnvKey;
  const id = process.env[key]?.trim();
  if (id) return id;
  // Retrocompat: plano antigo único → basic; multi-barber antigo → pro
  if (tier === 'basic') return process.env.STRIPE_PRICE_ID?.trim() || null;
  if (tier === 'pro') return process.env.STRIPE_MULTI_BARBER_PRICE_ID?.trim() || null;
  return null;
}

/** Resolve plano pelo Price ID da Stripe (env). */
export function resolveTierFromStripePriceId(
  priceId: string | null | undefined,
): WagooSubscriptionTier | null {
  if (!priceId) return null;
  const pairs: Array<[WagooSubscriptionTier, string | undefined]> = [
    ['agenda_web', process.env.STRIPE_PRICE_ID_AGENDA_WEB],
    ['basic', process.env.STRIPE_PRICE_ID_BASIC || process.env.STRIPE_PRICE_ID],
    ['pro', process.env.STRIPE_PRICE_ID_PRO || process.env.STRIPE_MULTI_BARBER_PRICE_ID],
    ['pro_plus', process.env.STRIPE_PRICE_ID_PRO_PLUS],
  ];
  for (const [tier, env] of pairs) {
    if (env?.trim() && env.trim() === priceId) return tier;
  }
  return null;
}

/** Resolve plano pelo Product ID (ex.: prod_UzR9AT2E2c1ov6 → agenda_web). */
export function resolveTierFromStripeProductId(
  productId: string | null | undefined,
): WagooSubscriptionTier | null {
  if (!productId) return null;
  const agendaProd = process.env.STRIPE_PRODUCT_ID_AGENDA_WEB?.trim();
  if (agendaProd && agendaProd === productId) return 'agenda_web';
  const basicProd = process.env.STRIPE_PRODUCT_ID_BASIC?.trim();
  if (basicProd && basicProd === productId) return 'basic';
  const proProd = process.env.STRIPE_PRODUCT_ID_PRO?.trim();
  if (proProd && proProd === productId) return 'pro';
  const proPlusProd = process.env.STRIPE_PRODUCT_ID_PRO_PLUS?.trim();
  if (proPlusProd && proPlusProd === productId) return 'pro_plus';
  return null;
}

export function parsePlanTierFromStripeMetadata(
  metadata: Record<string, string> | null | undefined,
): WagooSubscriptionTier | null {
  if (!metadata) return null;
  const fromTier = normalizeSubscriptionTier(metadata.plan_tier ?? metadata.subscription_tier);
  if (fromTier) return fromTier;
  if (metadata.plan_type === 'multi_barber') return 'pro';
  return null;
}

/** Metadata → price → product (nessa ordem). */
export function resolveTierFromStripeSubscription(sub: {
  metadata?: Record<string, string> | null;
  items?: { data?: Array<{ price?: { id?: string | null; product?: string | { id?: string } | null } | null }> };
}): WagooSubscriptionTier | null {
  const fromMeta = parsePlanTierFromStripeMetadata(sub.metadata as Record<string, string> | null);
  if (fromMeta) return fromMeta;

  const price = sub.items?.data?.[0]?.price;
  const fromPrice = resolveTierFromStripePriceId(price?.id ?? null);
  if (fromPrice) return fromPrice;

  const productRaw = price?.product;
  const productId =
    typeof productRaw === 'string'
      ? productRaw
      : productRaw && typeof productRaw === 'object'
        ? productRaw.id ?? null
        : null;
  return resolveTierFromStripeProductId(productId);
}
