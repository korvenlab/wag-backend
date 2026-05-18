-- Planos Wagoo: basic (1 usuário), pro (até 3), pro_plus (até 5)

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS subscription_tier text;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_subscription_tier_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_subscription_tier_check
  CHECK (
    subscription_tier IS NULL
    OR subscription_tier IN ('basic', 'pro', 'pro_plus')
  );

COMMENT ON COLUMN public.profiles.subscription_tier IS
  'Plano Stripe/admin: basic (1 usuário), pro (até 3), pro_plus (até 5). NULL = sem assinatura paga.';

-- Migração a partir de has_paid + multi_barber_plan
UPDATE public.profiles
SET subscription_tier = CASE
  WHEN COALESCE(has_paid, false) = false THEN NULL
  WHEN COALESCE(multi_barber_plan, false) = true THEN 'pro'
  ELSE 'basic'
END
WHERE subscription_tier IS NULL;
