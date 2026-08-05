-- Link privado de comissão por profissional (só os ganhos dele)

ALTER TABLE public.barbeiros
  ADD COLUMN IF NOT EXISTS commission_share_token text;

CREATE UNIQUE INDEX IF NOT EXISTS barbeiros_commission_share_token_uidx
  ON public.barbeiros (commission_share_token)
  WHERE commission_share_token IS NOT NULL;

COMMENT ON COLUMN public.barbeiros.commission_share_token IS
  'Token opaco para o profissional ver só a própria comissão/ganhos do mês (link público).';
