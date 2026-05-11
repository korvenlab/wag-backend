-- Cortesia via link (ex.: 60 dias) + promo links para o Korven Console.
-- `profiles.has_paid` = Stripe; acesso cortesia = `complimentary_access_until` (API calcula has_access).

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS complimentary_access_until timestamptz NULL;

COMMENT ON COLUMN public.profiles.complimentary_access_until IS
  'Fim do acesso cortesia Wagoo (link promocional). Independente de has_paid (Stripe).';

CREATE TABLE IF NOT EXISTS public.wagoo_promo_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text,
  complimentary_days integer NOT NULL DEFAULT 60 CHECK (complimentary_days > 0 AND complimentary_days <= 730),
  max_redemptions integer NULL CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  redemption_count integer NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  expires_at timestamptz NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.wagoo_promo_links IS
  'Links de cortesia Wagoo; CRUD via wag-backend /api/admin/wagoo/promo-links (Korven dashboard).';

CREATE TABLE IF NOT EXISTS public.wagoo_promo_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_link_id uuid NOT NULL REFERENCES public.wagoo_promo_links (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (promo_link_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_wagoo_promo_redemptions_user ON public.wagoo_promo_redemptions (user_id);

ALTER TABLE public.wagoo_promo_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wagoo_promo_redemptions ENABLE ROW LEVEL SECURITY;
