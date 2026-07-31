-- Plano Agenda Web (agendamento público sem IA) + tabelas de booking

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_subscription_tier_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_subscription_tier_check
  CHECK (
    subscription_tier IS NULL
    OR subscription_tier IN ('basic', 'pro', 'pro_plus', 'agenda_web')
  );

COMMENT ON COLUMN public.profiles.subscription_tier IS
  'Plano: agenda_web (site de agendamento), basic, pro, pro_plus. NULL = sem assinatura.';

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS booking_slug text,
  ADD COLUMN IF NOT EXISTS booking_logo_url text,
  ADD COLUMN IF NOT EXISTS booking_tagline text,
  ADD COLUMN IF NOT EXISTS booking_phone text,
  ADD COLUMN IF NOT EXISTS booking_address text,
  ADD COLUMN IF NOT EXISTS booking_published boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_booking_slug_uidx
  ON public.profiles (booking_slug)
  WHERE booking_slug IS NOT NULL AND length(trim(booking_slug)) > 0;

CREATE TABLE IF NOT EXISTS public.booking_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_brl numeric(10, 2) NOT NULL DEFAULT 0,
  duration_minutes integer NOT NULL DEFAULT 30
    CHECK (duration_minutes > 0 AND duration_minutes <= 480),
  image_url text,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS booking_services_profile_idx
  ON public.booking_services (profile_id, sort_order);

CREATE TABLE IF NOT EXISTS public.booking_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES public.booking_services (id) ON DELETE RESTRICT,
  client_name text NOT NULL,
  client_phone text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'cancelled', 'completed')),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_appointments_range_chk CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS booking_appointments_profile_time_idx
  ON public.booking_appointments (profile_id, starts_at)
  WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS booking_appointments_lookup_idx
  ON public.booking_appointments (profile_id, client_phone);

-- Storage público para logo / imagens de serviço (criar bucket se ainda não existir)
INSERT INTO storage.buckets (id, name, public)
VALUES ('booking-assets', 'booking-assets', true)
ON CONFLICT (id) DO NOTHING;

-- Políticas permissivas via service role no backend; leitura pública dos objetos
DROP POLICY IF EXISTS "booking_assets_public_read" ON storage.objects;
CREATE POLICY "booking_assets_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'booking-assets');
