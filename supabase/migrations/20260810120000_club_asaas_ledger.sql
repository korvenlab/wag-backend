-- Clube: migração Stripe Connect → Asaas (conta plataforma Wagoo) + ledger de repasse

ALTER TABLE public.club_plans
  ADD COLUMN IF NOT EXISTS asaas_external_ref text;

ALTER TABLE public.club_members
  ADD COLUMN IF NOT EXISTS asaas_customer_id text,
  ADD COLUMN IF NOT EXISTS asaas_subscription_id text,
  ADD COLUMN IF NOT EXISTS asaas_last_payment_id text;

CREATE INDEX IF NOT EXISTS club_members_asaas_subscription_idx
  ON public.club_members (asaas_subscription_id)
  WHERE asaas_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS club_members_asaas_payment_idx
  ON public.club_members (asaas_last_payment_id)
  WHERE asaas_last_payment_id IS NOT NULL;

COMMENT ON TABLE public.club_plans IS
  'Plano de clube mensal do salão (1 por perfil). Cobrança via Asaas na conta Wagoo.';

COMMENT ON TABLE public.club_members IS
  'Membros do clube; status sincronizado via webhooks Asaas (legado Stripe ainda possível).';

-- Chave PIX do salão para saque automático do saldo do clube
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS club_payout_pix_key text,
  ADD COLUMN IF NOT EXISTS club_payout_pix_key_type text
    CHECK (
      club_payout_pix_key_type IS NULL
      OR club_payout_pix_key_type IN ('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP')
    );

-- Ledger: crédito (mensalidade líquida) / débito (saque PIX)
CREATE TABLE IF NOT EXISTS public.club_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  entry_type text NOT NULL CHECK (entry_type IN ('credit', 'debit', 'adjustment')),
  amount_brl numeric(12, 2) NOT NULL CHECK (amount_brl >= 0),
  gross_brl numeric(12, 2),
  wagoo_fee_brl numeric(12, 2),
  description text,
  club_member_id uuid REFERENCES public.club_members (id) ON DELETE SET NULL,
  asaas_payment_id text,
  asaas_transfer_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS club_ledger_payment_credit_uidx
  ON public.club_ledger_entries (asaas_payment_id)
  WHERE asaas_payment_id IS NOT NULL AND entry_type = 'credit';

CREATE UNIQUE INDEX IF NOT EXISTS club_ledger_transfer_debit_uidx
  ON public.club_ledger_entries (asaas_transfer_id)
  WHERE asaas_transfer_id IS NOT NULL AND entry_type = 'debit';

CREATE INDEX IF NOT EXISTS club_ledger_profile_idx
  ON public.club_ledger_entries (profile_id, created_at DESC);

COMMENT ON TABLE public.club_ledger_entries IS
  'Saldo do salão no clube: créditos das mensalidades (líquido) e débitos de saque PIX.';

ALTER TABLE public.club_ledger_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS club_ledger_select_own ON public.club_ledger_entries;
CREATE POLICY club_ledger_select_own ON public.club_ledger_entries
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid());
