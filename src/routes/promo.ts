import express, { Request, Response } from 'express';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';
import { profileHasWagooAccess } from '../lib/profileAccess';
import { supabase } from '../lib/supabase';

const router = express.Router();

/**
 * Resgata código guardado no front (ex.: query `?wagoo_promo=` → sessionStorage) após login Google.
 * POST /api/promo/redeem  { "code": "abc123" }  Authorization: Bearer <access_token>
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

    const { error: redErr } = await supabase.from('wagoo_promo_redemptions').insert({
      promo_link_id: link.id,
      user_id: userId,
    });

    if (redErr) {
      if (redErr.code === '23505' || redErr.message.includes('duplicate')) {
        return res.status(409).json({ error: 'Você já resgatou este código.' });
      }
      return res.status(500).json({ error: redErr.message });
    }

    const { data: prof, error: profErr } = await supabase
      .from('profiles')
      .select('complimentary_access_until, subscription_tier, has_paid, stripe_subscription_id')
      .eq('id', userId)
      .maybeSingle();

    if (profErr) return res.status(500).json({ error: profErr.message });

    const now = Date.now();
    let base = new Date(now);
    const currentUntil = (prof as { complimentary_access_until?: string | null } | null)
      ?.complimentary_access_until;
    if (currentUntil) {
      const cur = new Date(currentUntil).getTime();
      if (Number.isFinite(cur) && cur > now) base = new Date(cur);
    }

    const newUntil = new Date(base.getTime() + days * 86_400_000).toISOString();

    const emailNorm = auth.user.email ? String(auth.user.email).trim().toLowerCase() : null;

    /** Cortesia sem assinatura Stripe → trata como Basic (IA + Agenda Web). */
    const hasStripeSub = Boolean(
      (prof as { stripe_subscription_id?: string | null } | null)?.stripe_subscription_id,
    );
    const currentTier = (prof as { subscription_tier?: string | null } | null)?.subscription_tier;
    const promoPatch: Record<string, unknown> = {
      complimentary_access_until: newUntil,
      is_ai_enabled: true,
    };
    if (!hasStripeSub && (!currentTier || currentTier === 'agenda_web')) {
      promoPatch.subscription_tier = 'basic';
      promoPatch.has_paid = true;
    }

    const { data: updatedRows, error: upProf } = await supabase
      .from('profiles')
      .update(promoPatch)
      .eq('id', userId)
      .select('id');

    if (upProf) {
      await supabase.from('wagoo_promo_redemptions').delete().eq('promo_link_id', link.id).eq('user_id', userId);
      return res.status(500).json({ error: upProf.message });
    }

    if (!updatedRows?.length) {
      const insRow: Record<string, unknown> = {
        id: userId,
        complimentary_access_until: newUntil,
        is_ai_enabled: true,
        has_paid: false,
        is_active: true,
      };
      if (emailNorm) insRow.email = emailNorm;
      const { error: insErr } = await supabase.from('profiles').upsert(insRow, { onConflict: 'id' });
      if (insErr) {
        await supabase.from('wagoo_promo_redemptions').delete().eq('promo_link_id', link.id).eq('user_id', userId);
        return res.status(500).json({ error: insErr.message });
      }
    }

    const { error: incErr } = await supabase
      .from('wagoo_promo_links')
      .update({ redemption_count: count + 1 })
      .eq('id', link.id)
      .eq('redemption_count', count);
    if (incErr) {
      console.error('[promo/redeem] increment redemption_count:', incErr);
    } else if (max != null) {
      // Optimistic lock: se outro request avançou o contador, ainda registámos o redeem
      // (único por user); o limite máximo pode falhar por 1 em corrida — aceitável vs overshoot grande.
    }

    const { data: fresh } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
    const has_access = profileHasWagooAccess(
      fresh as { has_paid?: boolean; complimentary_access_until?: string | null },
    );

    return res.json({
      ok: true,
      complimentary_access_until: newUntil,
      has_access,
    });
  } catch (e: unknown) {
    console.error('[promo/redeem]', e);
    return res.status(500).json({ error: e instanceof Error ? e.message : 'Erro interno' });
  }
});

export default router;
