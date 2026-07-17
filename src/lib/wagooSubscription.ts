export type WagooSubscriptionTier = 'basic' | 'pro' | 'pro_plus';

export const WAGOO_TIERS: WagooSubscriptionTier[] = ['basic', 'pro', 'pro_plus'];

export type WagooPlanDefinition = {
  tier: WagooSubscriptionTier;
  label: string;
  priceBrl: number;
  maxTeamUsers: number;
  stripePriceEnvKey: string;
};

/** `maxTeamUsers` = limite de profissionais na equipe (`barbeiros`). */
export const WAGOO_PLANS: Record<WagooSubscriptionTier, WagooPlanDefinition> = {
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

/** Lembretes WhatsApp antes do horário — só Pro e Pro+. */
export function tierSupportsReminders(tier: WagooSubscriptionTier | null): boolean {
  return tier === 'pro' || tier === 'pro_plus';
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

export function parsePlanTierFromStripeMetadata(
  metadata: Record<string, string> | null | undefined,
): WagooSubscriptionTier | null {
  if (!metadata) return null;
  const fromTier = normalizeSubscriptionTier(metadata.plan_tier ?? metadata.subscription_tier);
  if (fromTier) return fromTier;
  if (metadata.plan_type === 'multi_barber') return 'pro';
  return null;
}
