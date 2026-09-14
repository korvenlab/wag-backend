import express, { Request, Response } from 'express';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { profileHasWagooAccess } from '../lib/profileAccess';
import { supabase } from '../lib/supabase';
import {
  normalizeSubscriptionTier,
  syncLegacyFlagsFromTier,
  tierSupportsAi,
  type WagooSubscriptionTier,
} from '../lib/wagooSubscription';

const router = express.Router();

type ProfilePromoRow = {
  id?: string;
  email?: string | null;
  has_paid?: unknown;
  complimentary_access_until?: string | null;
  subscription_tier?: string | null;
};

function resolvePromoPlanTier(raw: unknown): WagooSubscriptionTier {
  return normalizeSubscriptionTier(raw) ?? 'basic';
}

/**
 * Resgata código guardado no front (ex.: query `?wagoo_promo=` → storage) após login Google.
 * POST /api/promo/redeem  { "code": "abc123" }  Authorization: Bearer <access_token>
 *
 * Não usa colunas Stripe legadas (`stripe_subscription_id` não existe em profiles).
 */
router.post('/redeem', async (req: Request, res: Response) => {
  try {
    const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
    if (!auth.ok) {
      return res.status(401).json({
        error:
          auth.reason === 'missing_token'
            ? 'Envie Authorization: Bearer com o access_token da sessão.'
            : 'Sessão inválida ou expirada.',
      });
    }

    const codeRaw = typeof req.body?.code === 'string' ? req.body.code.trim().toLowerCase() : '';
    if (!codeRaw || codeRaw.length > 64) {
      return res.status(400).json({ error: 'code inválido.' });
    }

    const { data: link, error: linkErr } = await supabase
      .from('wagoo_promo_links')
      .select('*')
      .eq('code', codeRaw)
      .eq('is_active', true)
      .maybeSingle();

    if (linkErr) return res.status(500).json({ error: linkErr.message });
    if (!link) return res.status(404).json({ error: 'Código não encontrado ou inativo.' });

    const expiresAt = link.expires_at as string | null;
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      return res.status(400).json({ error: 'Este código expirou.' });
    }

    const max = link.max_redemptions as number | null;
    const count = Number(link.redemption_count) || 0;
    if (max != null && count >= max) {
      return res.status(400).json({ error: 'Este código atingiu o limite de usos.' });
    }

    const days = Math.min(730, Math.max(1, Number(link.complimentary_days) || 60));
    const userId = auth.user.id;
    const emailNorm = auth.user.email ? String(auth.user.email).trim().toLowerCase() : null;

    const { error: redErr } = await supabase.from('wagoo_promo_redemptions').insert({
      promo_link_id: link.id,
      user_id: userId,
    });

    if (redErr) {
      if (redErr.code === '23505' || redErr.message.includes('duplicate')) {
        const { data: existingProf } = await supabase
          .from('profiles')
          .select('has_paid, complimentary_access_until, subscription_tier')
          .eq('id', userId)
          .maybeSingle();

        const hasAccess = profileHasWagooAccess(existingProf as ProfilePromoRow);
        if (hasAccess) {
          return res.status(200).json({
            ok: true,
            already: true,
            has_access: true,
            complimentary_access_until:
              (existingProf as ProfilePromoRow | null)?.complimentary_access_until ?? null,
          });
        }
        // Perfil sem acesso apesar do resgate — cai no fluxo de grant abaixo sem novo insert.
      } else {
        return res.status(500).json({ error: redErr.message });
      }
    }

    const { data: prof, error: profErr } = await supabase
      .from('profiles')
      .select('id, complimentary_access_until, subscription_tier, has_paid, email')
      .or(
        emailNorm
          ? `id.eq.${userId},email.eq."${emailNorm.replace(/"/g, '')}"`
          : `id.eq.${userId}`,
      )
      .limit(1)
      .maybeSingle();

    if (profErr) return res.status(500).json({ error: profErr.message });

    const profile = prof as ProfilePromoRow | null;
    const now = Date.now();
    let base = new Date(now);
    const currentUntil = profile?.complimentary_access_until;
    if (currentUntil) {
      const cur = new Date(currentUntil).getTime();
      if (Number.isFinite(cur) && cur > now) base = new Date(cur);
    }

    const newUntil = new Date(base.getTime() + days * 86_400_000).toISOString();

    /** Plano definido no link de cortesia (Agenda Web / Basic / Pro / Pro+). */
    const planTier = resolvePromoPlanTier(
      (link as { plan_tier?: unknown }).plan_tier,
    );
    const flags = syncLegacyFlagsFromTier(planTier);
    const promoPatch: Record<string, unknown> = {
      id: userId,
      complimentary_access_until: newUntil,
      has_paid: true,
      subscription_tier: planTier,
      multi_barber_plan: flags.multi_barber_plan,
      is_ai_enabled: tierSupportsAi(planTier),
    };
    if (emailNorm) promoPatch.email = emailNorm;

    let wrote = false;
    {
      const { data: updatedRows, error: upProf } = await supabase
        .from('profiles')
        .update(promoPatch)
        .eq('id', userId)
        .select('id');
      if (upProf) {
        await supabase.from('wagoo_promo_redemptions').delete().eq('promo_link_id', link.id).eq('user_id', userId);
        return res.status(500).json({ error: upProf.message });
      }
      wrote = Boolean(updatedRows?.length);
    }

    if (!wrote && emailNorm) {
      const { data: byEmail, error: upEmailErr } = await supabase
        .from('profiles')
        .update(promoPatch)
        .eq('email', emailNorm)
        .select('id');
      if (upEmailErr) {
        await supabase.from('wagoo_promo_redemptions').delete().eq('promo_link_id', link.id).eq('user_id', userId);
        return res.status(500).json({ error: upEmailErr.message });
      }
      wrote = Boolean(byEmail?.length);
    }

    if (!wrote) {
      const { error: insErr } = await supabase.from('profiles').upsert(promoPatch, { onConflict: 'id' });
      if (insErr) {
        await supabase.from('wagoo_promo_redemptions').delete().eq('promo_link_id', link.id).eq('user_id', userId);
        return res.status(500).json({ error: insErr.message });
      }
      wrote = true;
    }

    const { error: incErr } = await supabase
      .from('wagoo_promo_links')
      .update({ redemption_count: count + 1 })
      .eq('id', link.id)
      .eq('redemption_count', count);
    if (incErr) {
      console.error('[promo/redeem] increment redemption_count:', incErr);
    }

    const { data: fresh } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
    let has_access = profileHasWagooAccess(fresh as ProfilePromoRow);

    if (!has_access && emailNorm) {
      const { data: freshEmail } = await supabase
        .from('profiles')
        .select('*')
        .eq('email', emailNorm)
        .maybeSingle();
      has_access = profileHasWagooAccess(freshEmail as ProfilePromoRow);
    }

    if (!has_access) {
      return res.status(500).json({
        error: 'Cortesia gravada, mas o acesso ainda não ficou ativo. Tente de novo ou fale com o suporte.',
      });
    }

    return res.json({
      ok: true,
      complimentary_access_until: newUntil,
      has_access: true,
      subscription_tier: planTier,
    });
  } catch (e: unknown) {
    console.error('[promo/redeem]', e);
    return res.status(500).json({ error: e instanceof Error ? e.message : 'Erro interno' });
  }
});

export default router;
