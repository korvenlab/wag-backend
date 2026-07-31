-- Agenda Web: profissionais (providers) + vínculo em appointments

CREATE TABLE IF NOT EXISTS public.booking_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  name text NOT NULL,
  photo_url text,
  bio text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS booking_providers_profile_idx
  ON public.booking_providers (profile_id, sort_order);

ALTER TABLE public.booking_appointments
  ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES public.booking_providers (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS booking_appointments_provider_time_idx
  ON public.booking_appointments (provider_id, starts_at)
  WHERE status = 'confirmed' AND provider_id IS NOT NULL;

COMMENT ON TABLE public.booking_providers IS
  'Profissionais da Agenda Web (nome/foto). Sem login; cliente escolhe no wizard.';
