-- OTP WhatsApp + sessão de acesso ao clube (prova de posse do número)

CREATE TABLE IF NOT EXISTS public.club_phone_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  client_phone text NOT NULL,
  purpose text NOT NULL
    CHECK (purpose IN ('subscribe', 'member_access', 'club_benefit')),
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS club_phone_otps_lookup_idx
  ON public.club_phone_otps (profile_id, client_phone, purpose, created_at DESC);

CREATE INDEX IF NOT EXISTS club_phone_otps_expires_idx
  ON public.club_phone_otps (expires_at)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE public.club_phone_otps IS
  'Códigos OTP enviados no WhatsApp do salão para provar posse do telefone do membro.';

CREATE TABLE IF NOT EXISTS public.club_access_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  client_phone text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  purpose text NOT NULL
    CHECK (purpose IN ('subscribe', 'member_access', 'club_benefit')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS club_access_sessions_lookup_idx
  ON public.club_access_sessions (profile_id, client_phone, expires_at);

COMMENT ON TABLE public.club_access_sessions IS
  'Sessões após OTP válido; usadas na Agenda Web / portal do clube (não no chat WA).';

ALTER TABLE public.club_phone_otps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_access_sessions ENABLE ROW LEVEL SECURITY;
