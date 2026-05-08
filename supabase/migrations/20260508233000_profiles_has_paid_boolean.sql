-- profiles.has_paid — deve ser boolean no Postgres (Stripe webhook e PATCH admin gravam true/false).
-- Se a coluna não existir: cria com default false.
-- Se existir como text/varchar ("TRUE"/"FALSE"): converte com USING seguro.
-- Se já for boolean: o bloco não altera tipo.

DO $$
DECLARE
  dt text;
BEGIN
  SELECT c.data_type INTO dt
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'profiles'
    AND c.column_name = 'has_paid';

  IF dt IS NULL THEN
    ALTER TABLE public.profiles
      ADD COLUMN has_paid boolean NOT NULL DEFAULT false;
    COMMENT ON COLUMN public.profiles.has_paid IS 'Assinatura paga (Wagoo); atualizado por Stripe webhook e Korven admin.';
    RETURN;
  END IF;

  IF dt IN ('text', 'character varying', 'character') THEN
    ALTER TABLE public.profiles
      ALTER COLUMN has_paid TYPE boolean
      USING (
        CASE
          WHEN has_paid IS NULL THEN false
          WHEN trim(lower(has_paid::text)) IN ('true', 't', '1', 'yes') THEN true
          ELSE false
        END
      );
    ALTER TABLE public.profiles
      ALTER COLUMN has_paid SET DEFAULT false;
    -- Opcional: NOT NULL após limpar nulos (descomente se fizer sentido)
    -- ALTER TABLE public.profiles ALTER COLUMN has_paid SET NOT NULL;
    COMMENT ON COLUMN public.profiles.has_paid IS 'Assinatura paga (Wagoo); atualizado por Stripe webhook e Korven admin.';
    RETURN;
  END IF;

  -- Já é boolean (ou outro tipo não tratado aqui): só documenta
  COMMENT ON COLUMN public.profiles.has_paid IS 'Assinatura paga (Wagoo); atualizado por Stripe webhook e Korven admin.';
END $$;
