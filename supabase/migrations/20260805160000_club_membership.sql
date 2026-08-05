-- Clube mensal (assinatura do cliente do salão via Stripe Connect)

CREATE TABLE IF NOT EXISTS public.club_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL UNIQUE REFERENCES public.profiles (id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Clube Ilimitado',
  description text NOT NULL DEFAULT 'Assinatura mensal com acesso ao salão.',
  price_brl numeric(10, 2) NOT NULL CHECK (price_brl >= 1),
  active boolean NOT NULL DEFAULT false,
  stripe_product_id text,
  stripe_price_id text,
  stripe_payment_link_id text,
  payment_link_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.club_plans IS
  'Plano de clube mensal do salão (1 por perfil). Cobrança via Connect + Payment Link / Checkout.';

CREATE TABLE IF NOT EXISTS public.club_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  club_plan_id uuid REFERENCES public.club_plans (id) ON DELETE SET NULL,
  client_name text NOT NULL,
  client_phone text NOT NULL,
  client_email text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'past_due', 'canceled')),
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS club_members_profile_phone_uidx
  ON public.club_members (profile_id, client_phone);

CREATE INDEX IF NOT EXISTS club_members_subscription_idx
  ON public.club_members (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS club_members_profile_status_idx
  ON public.club_members (profile_id, status);

COMMENT ON TABLE public.club_members IS
  'Membros do clube do salão; status sincronizado via webhooks Stripe Connect.';

ALTER TABLE public.club_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS club_plans_select_own ON public.club_plans;
CREATE POLICY club_plans_select_own ON public.club_plans
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid());

DROP POLICY IF EXISTS club_plans_insert_own ON public.club_plans;
CREATE POLICY club_plans_insert_own ON public.club_plans
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid());

DROP POLICY IF EXISTS club_plans_update_own ON public.club_plans;
CREATE POLICY club_plans_update_own ON public.club_plans
  FOR UPDATE TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

DROP POLICY IF EXISTS club_members_select_own ON public.club_members;
CREATE POLICY club_members_select_own ON public.club_members
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid());
