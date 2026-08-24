-- Repasse manual de comissão (dono marca como pago; profissional vê no link)

CREATE TABLE IF NOT EXISTS public.barber_commission_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  barbeiro_id uuid NOT NULL REFERENCES public.barbeiros (id) ON DELETE CASCADE,
  period_year integer NOT NULL CHECK (period_year >= 2020 AND period_year <= 2100),
  period_month integer NOT NULL CHECK (period_month >= 1 AND period_month <= 12),
  amount_brl numeric(12, 2) CHECK (amount_brl IS NULL OR amount_brl >= 0),
  paid_at timestamptz NOT NULL DEFAULT now(),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS barber_commission_payouts_barber_period_uidx
  ON public.barber_commission_payouts (barbeiro_id, period_year, period_month);

CREATE INDEX IF NOT EXISTS barber_commission_payouts_profile_period_idx
  ON public.barber_commission_payouts (profile_id, period_year, period_month);

COMMENT ON TABLE public.barber_commission_payouts IS
  'Repasse manual de comissão marcado pelo dono; visível no link público do profissional.';

ALTER TABLE public.barber_commission_payouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS barber_commission_payouts_select_own ON public.barber_commission_payouts;
CREATE POLICY barber_commission_payouts_select_own ON public.barber_commission_payouts
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid());

DROP POLICY IF EXISTS barber_commission_payouts_insert_own ON public.barber_commission_payouts;
CREATE POLICY barber_commission_payouts_insert_own ON public.barber_commission_payouts
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid());

DROP POLICY IF EXISTS barber_commission_payouts_update_own ON public.barber_commission_payouts;
CREATE POLICY barber_commission_payouts_update_own ON public.barber_commission_payouts
  FOR UPDATE TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

DROP POLICY IF EXISTS barber_commission_payouts_delete_own ON public.barber_commission_payouts;
CREATE POLICY barber_commission_payouts_delete_own ON public.barber_commission_payouts
  FOR DELETE TO authenticated
  USING (profile_id = auth.uid());
