-- Capa personalizada da vitrine Agenda Web
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS booking_cover_url text;

COMMENT ON COLUMN public.profiles.booking_cover_url IS
  'Imagem de capa (hero) da página pública /a/:slug';
