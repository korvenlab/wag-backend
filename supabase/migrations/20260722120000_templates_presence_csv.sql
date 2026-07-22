-- Templates de resposta + confirmação de presença pós-lembrete.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS response_templates jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.profiles.response_templates IS
  'Guia de estilo/personalidade WhatsApp+IA (não script): saudacao, apos_agendar, ao_cancelar, fora_horario, notas_ia.';

ALTER TABLE public.appointment_reminders
  ADD COLUMN IF NOT EXISTS presence_status text,
  ADD COLUMN IF NOT EXISTS presence_replied_at timestamptz;

ALTER TABLE public.appointment_reminders
  DROP CONSTRAINT IF EXISTS appointment_reminders_presence_status_check;

ALTER TABLE public.appointment_reminders
  ADD CONSTRAINT appointment_reminders_presence_status_check
  CHECK (
    presence_status IS NULL
    OR presence_status IN ('pending', 'confirmed', 'declined')
  );

COMMENT ON COLUMN public.appointment_reminders.presence_status IS
  'pending após envio do lembrete; confirmed/declined quando o cliente responde SIM/NÃO.';

COMMENT ON COLUMN public.appointment_reminders.presence_replied_at IS
  'Quando o cliente confirmou ou recusou a presença.';

CREATE INDEX IF NOT EXISTS appointment_reminders_presence_pending_idx
  ON public.appointment_reminders (user_id, client_phone, starts_at)
  WHERE sent_at IS NOT NULL AND presence_status = 'pending';
