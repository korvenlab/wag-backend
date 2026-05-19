-- Link público de visualização do calendário da loja (somente leitura)

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS calendar_share_token text;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_calendar_share_token_uidx
  ON public.profiles (calendar_share_token)
  WHERE calendar_share_token IS NOT NULL;

COMMENT ON COLUMN public.profiles.calendar_share_token IS
  'Slug público do calendário (derivado do store_name), ex.: barbearia-do-joao → /calendario/publico/barbearia-do-joao';
