-- Nicho do negócio: a IA usa vocabulário adequado (barbeiro vs manicure vs cabeleireiro).
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS business_niche text,
  ADD COLUMN IF NOT EXISTS business_niche_custom text;

COMMENT ON COLUMN public.profiles.business_niche IS
  'Nicho do estabelecimento: barbearia | salao | manicure | estetica | outro. NULL = onboarding pendente.';

COMMENT ON COLUMN public.profiles.business_niche_custom IS
  'Rótulo livre quando business_niche = outro.';

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_business_niche_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_business_niche_check
  CHECK (
    business_niche IS NULL
    OR business_niche IN ('barbearia', 'salao', 'manicure', 'estetica', 'outro')
  );
