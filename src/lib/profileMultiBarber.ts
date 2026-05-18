import {
  tierFromLegacyProfile,
  tierSupportsMultiBarberAi,
  type WagooSubscriptionTier,
} from './wagooSubscription';

export type ProfileMultiBarberRow = {
  multi_barber_plan?: boolean | null;
  subscription_tier?: unknown;
  has_paid?: unknown;
};

export function profileSubscriptionTier(
  row: ProfileMultiBarberRow | null | undefined,
): WagooSubscriptionTier | null {
  return tierFromLegacyProfile(row ?? {});
}

export function profileHasMultiBarberPlan(row: ProfileMultiBarberRow | null | undefined): boolean {
  const tier = profileSubscriptionTier(row);
  if (tier) return tierSupportsMultiBarberAi(tier);
  if (!row) return false;
  const v = row.multi_barber_plan;
  if (v === true) return true;
  if (v === false || v == null) return false;
  if (typeof v === 'string') {
    const s = (v as string).trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'sim' || s === 'yes';
  }
  return Boolean(v);
}
