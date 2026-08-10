-- Sinal/agendamento: Asaas payment id na conta plataforma Wagoo
ALTER TABLE public.booking_appointments
  ADD COLUMN IF NOT EXISTS asaas_payment_id text;

CREATE INDEX IF NOT EXISTS booking_appointments_asaas_payment_idx
  ON public.booking_appointments (asaas_payment_id)
  WHERE asaas_payment_id IS NOT NULL;

COMMENT ON COLUMN public.booking_appointments.asaas_payment_id IS
  'Cobrança Asaas (sinal/antecipação) na conta Wagoo.';

COMMENT ON COLUMN public.profiles.booking_deposit_enabled IS
  'Se true e Asaas configurado, agendamento exige sinal via fatura Asaas (conta Wagoo).';
