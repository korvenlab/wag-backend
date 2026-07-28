-- Tabela de preços / serviços do negócio (a IA responde no WhatsApp).
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS service_prices jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.profiles.service_prices IS
  'Lista de serviços e valores [{name, price, notes?}]. A IA usa ao responder perguntas de preço no WhatsApp.';
