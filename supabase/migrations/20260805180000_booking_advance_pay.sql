-- Pagamento antecipado opcional (100% do serviço) controlado pelo dono

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS booking_advance_pay_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.booking_advance_pay_enabled IS
  'Se true e o sinal obrigatório estiver desligado, o cliente pode pagar 100% do serviço adiantado na Agenda Web.';
