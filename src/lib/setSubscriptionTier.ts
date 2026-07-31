import type { SupabaseClient } from '@supabase/supabase-js';
import {
  normalizeSubscriptionTier,
  syncLegacyFlagsFromTier,
  type WagooSubscriptionTier,
} from './wagooSubscription';

export async function setProfileSubscriptionTierByUserId(
  supabase: SupabaseClient,
  userId: string,
  tier: WagooSubscriptionTier | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const normalized = tier ? normalizeSubscriptionTier(tier) : null;
  if (tier && !normalized) {
    return { ok: false, error: 'Plano inválido. Use agenda_web, basic, pro ou pro_plus.' };
  }

  const flags = syncLegacyFlagsFromTier(normalized);

  const updatePayload: Record<string, unknown> = {
    subscription_tier: normalized,
    has_paid: flags.has_paid,
    multi_barber_plan: flags.multi_barber_plan,
  };

  // Agenda Web não usa IA; planos IA reativam o toggle por padrão.
  if (normalized === 'agenda_web') {
    updatePayload.is_ai_enabled = false;
  } else if (normalized === 'basic' || normalized === 'pro' || normalized === 'pro_plus') {
    updatePayload.is_ai_enabled = true;
  }

  const { error } = await supabase
    .from('profiles')
    .update(updatePayload)
    .eq('id', userId);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
