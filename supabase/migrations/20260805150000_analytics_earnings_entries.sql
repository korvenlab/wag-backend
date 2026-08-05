-- Ganhos manuais por profissional (Analytics) + preferência de colunas do CSV

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS analytics_export_columns jsonb;

COMMENT ON COLUMN public.profiles.analytics_export_columns IS
  'Lista de keys de colunas do export CSV de Analytics (null = default).';

CREATE TABLE IF NOT EXISTS public.barber_earnings_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  barbeiro_id uuid REFERENCES public.barbeiros (id) ON DELETE SET NULL,
  barber_name text NOT NULL CHECK (char_length(trim(barber_name)) >= 1),
  period_year integer NOT NULL CHECK (period_year >= 2020 AND period_year <= 2100),
  period_month integer NOT NULL CHECK (period_month >= 1 AND period_month <= 12),
  amount_brl numeric(12, 2) NOT NULL CHECK (amount_brl >= 0),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS barber_earnings_entries_unique_period_name
  ON public.barber_earnings_entries (
    profile_id,
    period_year,
    period_month,
    lower(trim(barber_name))
  );

CREATE INDEX IF NOT EXISTS barber_earnings_entries_profile_period_idx
  ON public.barber_earnings_entries (profile_id, period_year, period_month);

COMMENT ON TABLE public.barber_earnings_entries IS
  'Lançamento manual de ganhos do profissional no mês; substitui comissão automática no Analytics.';

ALTER TABLE public.barber_earnings_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS barber_earnings_select_own ON public.barber_earnings_entries;
CREATE POLICY barber_earnings_select_own ON public.barber_earnings_entries
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid());

DROP POLICY IF EXISTS barber_earnings_insert_own ON public.barber_earnings_entries;
CREATE POLICY barber_earnings_insert_own ON public.barber_earnings_entries
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid());

DROP POLICY IF EXISTS barber_earnings_update_own ON public.barber_earnings_entries;
CREATE POLICY barber_earnings_update_own ON public.barber_earnings_entries
  FOR UPDATE TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

DROP POLICY IF EXISTS barber_earnings_delete_own ON public.barber_earnings_entries;
CREATE POLICY barber_earnings_delete_own ON public.barber_earnings_entries
  FOR DELETE TO authenticated
  USING (profile_id = auth.uid());
