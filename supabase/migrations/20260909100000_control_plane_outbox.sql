-- Entrega durável Wagoo -> Korven control plane e idempotência de comandos admin.

CREATE TABLE IF NOT EXISTS public.wagoo_control_plane_outbox (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  external_user_id text NOT NULL,
  dedupe_key text UNIQUE,
  envelope jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wagoo_control_plane_outbox_pending
  ON public.wagoo_control_plane_outbox (next_attempt_at, created_at)
  WHERE delivered_at IS NULL;

ALTER TABLE public.wagoo_control_plane_outbox ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wagoo_control_plane_outbox TO service_role;

CREATE OR REPLACE FUNCTION public.wagoo_enqueue_control_plane_event(
  p_event jsonb,
  p_dedupe_key text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.wagoo_control_plane_outbox (
    event_id,
    event_type,
    external_user_id,
    dedupe_key,
    envelope
  ) VALUES (
    p_event->>'event_id',
    p_event->>'event_type',
    p_event->>'external_user_id',
    NULLIF(p_dedupe_key, ''),
    p_event
  )
  ON CONFLICT DO NOTHING;

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.wagoo_claim_control_plane_events(
  p_limit integer DEFAULT 25
) RETURNS TABLE (
  event_id text,
  envelope jsonb,
  attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT o.event_id
    FROM public.wagoo_control_plane_outbox o
    WHERE o.delivered_at IS NULL
      AND o.next_attempt_at <= now()
      AND (o.lease_until IS NULL OR o.lease_until < now())
    ORDER BY o.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
  )
  UPDATE public.wagoo_control_plane_outbox o
  SET lease_until = now() + interval '30 seconds',
      attempts = o.attempts + 1
  FROM claimed
  WHERE o.event_id = claimed.event_id
  RETURNING o.event_id, o.envelope, o.attempts;
END;
$$;

REVOKE ALL ON FUNCTION public.wagoo_enqueue_control_plane_event(jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wagoo_claim_control_plane_events(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wagoo_enqueue_control_plane_event(jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wagoo_claim_control_plane_events(integer) TO service_role;

CREATE TABLE IF NOT EXISTS public.wagoo_admin_command_receipts (
  idempotency_key text PRIMARY KEY,
  command text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'succeeded')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE public.wagoo_admin_command_receipts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wagoo_admin_command_receipts TO service_role;

COMMENT ON TABLE public.wagoo_control_plane_outbox IS
  'Outbox durável para eventos assinados enviados ao Korven control plane.';
COMMENT ON TABLE public.wagoo_admin_command_receipts IS
  'Respostas persistidas para repetição segura de comandos admin via Idempotency-Key.';
