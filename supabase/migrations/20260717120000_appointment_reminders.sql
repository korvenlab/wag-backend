-- Lembretes de agendamento (Pro / Pro+): fila + settings no perfil.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS reminders_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS remind_before_minutes integer NOT NULL DEFAULT 60;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_remind_before_minutes_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_remind_before_minutes_check
  CHECK (remind_before_minutes BETWEEN 5 AND 1440);

COMMENT ON COLUMN public.profiles.reminders_enabled IS
  'Pro/Pro+: enviar lembrete WhatsApp antes do horário marcado.';

COMMENT ON COLUMN public.profiles.remind_before_minutes IS
  'Minutos de antecedência do lembrete (5–1440). Só usado se reminders_enabled.';

CREATE TABLE IF NOT EXISTS public.appointment_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  google_event_id text NOT NULL,
  client_phone text NOT NULL,
  client_name text,
  barber_name text,
  starts_at timestamptz NOT NULL,
  remind_at timestamptz NOT NULL,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, google_event_id)
);

CREATE INDEX IF NOT EXISTS appointment_reminders_due_idx
  ON public.appointment_reminders (remind_at)
  WHERE sent_at IS NULL;

COMMENT ON TABLE public.appointment_reminders IS
  'Fila de lembretes WhatsApp; worker no backend marca sent_at após envio.';
