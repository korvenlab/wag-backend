-- Plano Multi-Barbeiro + equipe vinculada ao usuário master (profiles.id)

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS multi_barber_plan boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.multi_barber_plan IS
  'Plano premium: gestão de múltiplos barbeiros no mesmo WhatsApp (Stripe add-on ou admin).';

CREATE TABLE IF NOT EXISTS public.barbeiros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nome text NOT NULL CHECK (char_length(trim(nome)) >= 1),
  google_calendar_email text NOT NULL CHECK (position('@' in google_calendar_email) > 1),
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS barbeiros_user_id_idx ON public.barbeiros(user_id);
CREATE INDEX IF NOT EXISTS barbeiros_user_ativo_idx ON public.barbeiros(user_id, ativo);

COMMENT ON TABLE public.barbeiros IS
  'Profissionais da equipe; convites de agenda via e-mail do Google Calendar do barbeiro.';

ALTER TABLE public.barbeiros ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS barbeiros_select_own ON public.barbeiros;
CREATE POLICY barbeiros_select_own ON public.barbeiros
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS barbeiros_insert_own ON public.barbeiros;
CREATE POLICY barbeiros_insert_own ON public.barbeiros
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS barbeiros_update_own ON public.barbeiros;
CREATE POLICY barbeiros_update_own ON public.barbeiros
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS barbeiros_delete_own ON public.barbeiros;
CREATE POLICY barbeiros_delete_own ON public.barbeiros
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());
