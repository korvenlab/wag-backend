import crypto from 'crypto';

type OAuthStatePayload = {
  sub: string;
  email: string;
  exp: number;
};

function signingKey(): string {
  return (
    process.env.GOOGLE_OAUTH_STATE_SECRET?.trim() ||
    process.env.GOOGLE_CLIENT_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    'wagoo-dev-oauth-state'
  );
}

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64url');
}

function sign(payloadB64: string): string {
  return crypto.createHmac('sha256', signingKey()).update(payloadB64).digest('base64url');
}

/** State assinado (user id + email + expiry) para o callback Google Calendar. */
export function createGoogleOAuthState(userId: string, email: string, ttlSec = 600): string {
  const payload: OAuthStatePayload = {
    sub: userId,
    email: email.trim().toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

export function verifyGoogleOAuthState(
  state: unknown,
): { ok: true; payload: OAuthStatePayload } | { ok: false; error: string } {
  if (typeof state !== 'string' || !state.includes('.')) {
    return { ok: false, error: 'state inválido' };
  }
  const [payloadB64, sig] = state.split('.', 2);
  if (!payloadB64 || !sig) return { ok: false, error: 'state inválido' };

  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'state adulterado' };
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as OAuthStatePayload;
    if (!payload?.sub || !payload?.email || !payload?.exp) {
      return { ok: false, error: 'state incompleto' };
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return { ok: false, error: 'state expirado — tente conectar a agenda de novo' };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, error: 'state ilegível' };
  }
}
