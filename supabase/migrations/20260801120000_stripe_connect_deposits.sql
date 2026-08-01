-- Stripe Connect (Express) + sinal / depósito no agendamento público

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id text,
  ADD COLUMN IF NOT EXISTS stripe_connect_charges_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_connect_payouts_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_connect_details_submitted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS booking_deposit_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS booking_deposit_percent numeric(5, 2) NOT NULL DEFAULT 30
    CHECK (booking_deposit_percent >= 1 AND booking_deposit_percent <= 100);

COMMENT ON COLUMN public.profiles.stripe_connect_account_id IS
  'Conta Connect Express (acct_...) do salão para receber pagamentos de clientes.';
COMMENT ON COLUMN public.profiles.booking_deposit_enabled IS
  'Se true e Connect ativo, agendamento público exige sinal (depósito) via Stripe Checkout.';
COMMENT ON COLUMN public.profiles.booking_deposit_percent IS
  'Percentual do valor total cobrado como sinal (1–100). Taxa Wagoo = 2% do valor cobrado.';

CREATE UNIQUE INDEX IF NOT EXISTS profiles_stripe_connect_account_uidx
  ON public.profiles (stripe_connect_account_id)
  WHERE stripe_connect_account_id IS NOT NULL;

-- Status pending_payment: horário reservado até pagar (ou expirar)
ALTER TABLE public.booking_appointments
  DROP CONSTRAINT IF EXISTS booking_appointments_status_check;

ALTER TABLE public.booking_appointments
  ADD CONSTRAINT booking_appointments_status_check
  CHECK (status IN ('pending_payment', 'confirmed', 'cancelled', 'completed'));

ALTER TABLE public.booking_appointments
  ADD COLUMN IF NOT EXISTS price_brl numeric(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_amount_brl numeric(10, 2),
  ADD COLUMN IF NOT EXISTS application_fee_brl numeric(10, 2),
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'not_required'
    CHECK (payment_status IN ('not_required', 'pending', 'paid', 'failed', 'expired')),
  ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text,
  ADD COLUMN IF NOT EXISTS payment_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

COMMENT ON COLUMN public.booking_appointments.application_fee_brl IS
  'Taxa da plataforma Wagoo (2% do sinal). Taxa Stripe de processamento é cobrada à parte na conta Connect.';

DROP INDEX IF EXISTS booking_appointments_profile_time_idx;
CREATE INDEX booking_appointments_profile_time_idx
  ON public.booking_appointments (profile_id, starts_at)
  WHERE status IN ('confirmed', 'pending_payment');

CREATE INDEX IF NOT EXISTS booking_appointments_checkout_session_idx
  ON public.booking_appointments (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
