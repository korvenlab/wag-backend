-- Preferência: IA pode usar emojis nas respostas do WhatsApp.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ai_use_emojis boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.ai_use_emojis IS
  'Quando true, a IA pode usar emojis nas respostas do WhatsApp.';
