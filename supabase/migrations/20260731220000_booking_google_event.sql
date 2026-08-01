-- Agenda Web: vínculo do agendamento com evento no Google Calendar
ALTER TABLE public.booking_appointments
  ADD COLUMN IF NOT EXISTS google_event_id text;

CREATE INDEX IF NOT EXISTS booking_appointments_google_event_idx
  ON public.booking_appointments (google_event_id)
  WHERE google_event_id IS NOT NULL;

COMMENT ON COLUMN public.booking_appointments.google_event_id IS
  'ID do evento no Google Calendar (primary) do dono da agenda, se sincronizado.';
