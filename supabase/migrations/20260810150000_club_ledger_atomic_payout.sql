-- Saque atômico: impede double-spend (dois PIX com o mesmo saldo).
-- Serializa por profile_id e só debita se o saldo cobrir o valor.

CREATE OR REPLACE FUNCTION public.club_ledger_try_debit(
  p_profile_id uuid,
  p_amount numeric,
  p_asaas_transfer_id text,
  p_description text DEFAULT 'Saque PIX'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bal numeric;
  v_id uuid;
BEGIN
  IF p_profile_id IS NULL OR p_asaas_transfer_id IS NULL OR length(trim(p_asaas_transfer_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Parâmetros inválidos.');
  END IF;

  IF p_amount IS NULL OR p_amount < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Valor mínimo de saque: R$ 1,00.');
  END IF;

  -- Um saque por vez por salão
  PERFORM pg_advisory_xact_lock(hashtext('club_ledger:' || p_profile_id::text));

  IF EXISTS (
    SELECT 1
    FROM public.club_ledger_entries
    WHERE asaas_transfer_id = p_asaas_transfer_id
      AND entry_type = 'debit'
  ) THEN
    RETURN jsonb_build_object('ok', true, 'already', true);
  END IF;

  SELECT COALESCE(SUM(
    CASE
      WHEN entry_type IN ('credit', 'adjustment') THEN amount_brl
      WHEN entry_type = 'debit' THEN -amount_brl
      ELSE 0
    END
  ), 0)
  INTO v_bal
  FROM public.club_ledger_entries
  WHERE profile_id = p_profile_id;

  v_bal := round(v_bal::numeric, 2);

  IF v_bal + 0.001 < p_amount THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', format('Saldo disponível: R$ %s.', replace(to_char(v_bal, 'FM999999990.00'), '.', ',')),
      'balance', v_bal
    );
  END IF;

  INSERT INTO public.club_ledger_entries (
    profile_id,
    entry_type,
    amount_brl,
    description,
    asaas_transfer_id
  ) VALUES (
    p_profile_id,
    'debit',
    round(p_amount::numeric, 2),
    COALESCE(NULLIF(trim(p_description), ''), 'Saque PIX'),
    p_asaas_transfer_id
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_id,
    'balance_after', round(v_bal - p_amount, 2)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.club_ledger_try_debit(uuid, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.club_ledger_try_debit(uuid, numeric, text, text) TO service_role;

COMMENT ON FUNCTION public.club_ledger_try_debit IS
  'Debita o ledger só se o saldo cobrir; lock por profile evita saque duplicado concorrente.';

-- Estorno do hold se a transferência Asaas falhar após o débito.
CREATE OR REPLACE FUNCTION public.club_ledger_release_debit(
  p_profile_id uuid,
  p_asaas_transfer_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted int;
BEGIN
  DELETE FROM public.club_ledger_entries
  WHERE profile_id = p_profile_id
    AND entry_type = 'debit'
    AND asaas_transfer_id = p_asaas_transfer_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'deleted', v_deleted);
END;
$$;

REVOKE ALL ON FUNCTION public.club_ledger_release_debit(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.club_ledger_release_debit(uuid, text) TO service_role;
