-- Modo barbeiro: WhatsApp do profissional + digest semanal de comissão (toda segunda)

ALTER TABLE public.barbeiros
  ADD COLUMN IF NOT EXISTS whatsapp_phone text NULL,
  ADD COLUMN IF NOT EXISTS commission_digest_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS commission_digest_last_sent_at timestamptz NULL;

COMMENT ON COLUMN public.barbeiros.whatsapp_phone IS
  'Telefone WhatsApp do profissional (somente dígitos, preferência E.164 BR com 55) para resumo de comissão.';
COMMENT ON COLUMN public.barbeiros.commission_digest_enabled IS
  'Se true, envia resumo de comissão da semana anterior toda segunda pelo WhatsApp do salão.';
COMMENT ON COLUMN public.barbeiros.commission_digest_last_sent_at IS
  'Último envio do digest semanal (evita duplicar no mesmo dia).';
