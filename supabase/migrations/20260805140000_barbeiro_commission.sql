-- Comissão % por profissional (equipe) — usada no export CSV de Analytics

ALTER TABLE public.barbeiros
  ADD COLUMN IF NOT EXISTS commission_percent numeric(5, 2) NOT NULL DEFAULT 0
    CHECK (commission_percent >= 0 AND commission_percent <= 100);

COMMENT ON COLUMN public.barbeiros.commission_percent IS
  'Percentual de comissão do profissional sobre o valor do serviço em agendamentos pagos (0–100).';
