import crypto from 'crypto';
import { supabase } from '../lib/supabase';
import { log } from '../lib/logger';
import { digitsPhone } from './clubMembership';

const TAG = 'CLUB_OTP';

export type ClubOtpPurpose = 'subscribe' | 'member_access' | 'club_benefit';

const OTP_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;

function otpPepper(): string {
  return (
    process.env.CLUB_OTP_PEPPER ||
    process.env.JWT_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    'wagoo-club-otp-dev'
  );
}

function hashCode(code: string): string {
  return crypto.createHmac('sha256', otpPepper()).update(code).digest('hex');
}

function hashToken(token: string): string {
  return crypto.createHmac('sha256', otpPepper()).update(`sess:${token}`).digest('hex');
}

function generateCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Variantes BR (com/sem 55) para JID e lookup. */
export function phoneVariants(raw: string): string[] {
  const d = digitsPhone(raw);
  if (!d) return [];
  const set = new Set<string>([d]);
  if (d.startsWith('55') && d.length >= 12) set.add(d.slice(2));
  else if (d.length === 10 || d.length === 11) set.add(`55${d}`);
  return [...set];
}

function waJidCandidates(phone: string): string[] {
  return phoneVariants(phone).map((p) => `${p}@s.whatsapp.net`);
}

async function loadOwnerEmail(profileId: string): Promise<string | null> {
  const { data } = await supabase
    .from('profiles')
    .select('email')
    .eq('id', profileId)
    .maybeSingle();
  return data?.email ? String(data.email) : null;
}

async function sendWhatsAppText(
  profileId: string,
  phone: string,
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = await loadOwnerEmail(profileId);
  if (!email) {
    return { ok: false, error: 'Salão sem WhatsApp configurado.' };
  }

  const { sessions } = await import('./whatsapp');
  const sock = sessions[email];
  if (!sock?.user) {
    return {
      ok: false,
      error:
        'O WhatsApp do salão está offline. Peça ao salão para reconectar o zap e tente de novo.',
    };
  }

  let lastErr: unknown = null;
  for (const jid of waJidCandidates(phone)) {
    try {
      await sock.sendMessage(jid, { text });
      log.info(TAG, 'OTP enviado', { profileId, phone: digitsPhone(phone), jid });
      return { ok: true };
    } catch (err) {
      lastErr = err;
    }
  }

  log.error(TAG, 'falha ao enviar OTP', lastErr, { profileId, phone: digitsPhone(phone) });
  return { ok: false, error: 'Não foi possível enviar o código no WhatsApp.' };
}

async function countRecentSends(
  profileId: string,
  phone: string,
  purpose: ClubOtpPurpose,
): Promise<{ hourCount: number; lastCreatedAt: Date | null }> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('club_phone_otps')
    .select('created_at')
    .eq('profile_id', profileId)
    .eq('client_phone', phone)
    .eq('purpose', purpose)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(MAX_SENDS_PER_HOUR + 1);

  const rows = data ?? [];
  return {
    hourCount: rows.length,
    lastCreatedAt: rows[0]?.created_at ? new Date(String(rows[0].created_at)) : null,
  };
}

/**
 * Gera e envia OTP via WhatsApp do salão.
 * `shouldSend` permite anti-enumeração (ex.: só envia se for membro).
 */
export async function requestClubOtp(opts: {
  profileId: string;
  phone: string;
  purpose: ClubOtpPurpose;
  storeName?: string | null;
  /** Se false, não envia (resposta idêntica ao cliente). */
  shouldSend: boolean;
}): Promise<{ ok: true; sent: boolean; cooldown_seconds?: number } | { ok: false; error: string }> {
  const phone = digitsPhone(opts.phone);
  if (phone.length < 10) {
    return { ok: false, error: 'Informe um WhatsApp válido com DDD.' };
  }

  const { hourCount, lastCreatedAt } = await countRecentSends(
    opts.profileId,
    phone,
    opts.purpose,
  );

  if (lastCreatedAt) {
    const waitMs = RESEND_COOLDOWN_MS - (Date.now() - lastCreatedAt.getTime());
    if (waitMs > 0) {
      return {
        ok: true,
        sent: false,
        cooldown_seconds: Math.ceil(waitMs / 1000),
      };
    }
  }

  if (hourCount >= MAX_SENDS_PER_HOUR) {
    return {
      ok: false,
      error: 'Muitos códigos pedidos. Aguarde cerca de 1 hora e tente de novo.',
    };
  }

  if (!opts.shouldSend) {
    return { ok: true, sent: false };
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

  // Invalida códigos anteriores não consumidos
  await supabase
    .from('club_phone_otps')
    .update({ consumed_at: new Date().toISOString() })
    .eq('profile_id', opts.profileId)
    .eq('client_phone', phone)
    .eq('purpose', opts.purpose)
    .is('consumed_at', null);

  const { error: insertErr } = await supabase.from('club_phone_otps').insert({
    profile_id: opts.profileId,
    client_phone: phone,
    purpose: opts.purpose,
    code_hash: hashCode(code),
    expires_at: expiresAt,
  });

  if (insertErr) {
    log.error(TAG, 'insert OTP falhou', insertErr, { profileId: opts.profileId });
    return { ok: false, error: 'Não foi possível gerar o código.' };
  }

  const store = (opts.storeName || 'Salão').trim() || 'Salão';
  const text =
    `*${store}* — código Wagoo\n\n` +
    `Seu código de verificação: *${code}*\n` +
    `Válido por 10 minutos.\n\n` +
    `Se você não pediu isso, ignore esta mensagem.`;

  const sent = await sendWhatsAppText(opts.profileId, phone, text);
  if (!sent.ok) {
    return { ok: false, error: sent.error };
  }

  return { ok: true, sent: true };
}

export async function verifyClubOtp(opts: {
  profileId: string;
  phone: string;
  purpose: ClubOtpPurpose;
  code: string;
}): Promise<
  | { ok: true; club_token: string; expires_at: string }
  | { ok: false; error: string }
> {
  const phone = digitsPhone(opts.phone);
  const code = String(opts.code || '')
    .replace(/\D/g, '')
    .slice(0, 8);

  if (phone.length < 10) {
    return { ok: false, error: 'Informe um WhatsApp válido com DDD.' };
  }
  if (code.length !== 6) {
    return { ok: false, error: 'Informe o código de 6 dígitos.' };
  }

  const { data: row } = await supabase
    .from('club_phone_otps')
    .select('id, code_hash, expires_at, attempts, consumed_at')
    .eq('profile_id', opts.profileId)
    .eq('client_phone', phone)
    .eq('purpose', opts.purpose)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!row) {
    return { ok: false, error: 'Código inválido ou expirado. Peça um novo.' };
  }

  if (row.consumed_at) {
    return { ok: false, error: 'Código já usado. Peça um novo.' };
  }

  if (new Date(String(row.expires_at)).getTime() < Date.now()) {
    await supabase
      .from('club_phone_otps')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', row.id);
    return { ok: false, error: 'Código expirado. Peça um novo.' };
  }

  if (Number(row.attempts) >= MAX_ATTEMPTS) {
    await supabase
      .from('club_phone_otps')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', row.id);
    return { ok: false, error: 'Muitas tentativas. Peça um novo código.' };
  }

  const expected = String(row.code_hash);
  const got = hashCode(code);
  const match =
    expected.length === got.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));

  if (!match) {
    await supabase
      .from('club_phone_otps')
      .update({ attempts: Number(row.attempts) + 1 })
      .eq('id', row.id);
    return { ok: false, error: 'Código incorreto.' };
  }

  await supabase
    .from('club_phone_otps')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', row.id);

  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  // Remove sessões antigas do mesmo propósito
  await supabase
    .from('club_access_sessions')
    .delete()
    .eq('profile_id', opts.profileId)
    .eq('client_phone', phone)
    .eq('purpose', opts.purpose);

  const { error: sessErr } = await supabase.from('club_access_sessions').insert({
    profile_id: opts.profileId,
    client_phone: phone,
    token_hash: hashToken(token),
    purpose: opts.purpose,
    expires_at: expiresAt,
  });

  if (sessErr) {
    log.error(TAG, 'criar sessão falhou', sessErr, { profileId: opts.profileId });
    return { ok: false, error: 'Não foi possível criar a sessão.' };
  }

  return { ok: true, club_token: token, expires_at: expiresAt };
}

/**
 * Valida token de sessão OTP. Aceita purpose exato ou `club_benefit` / `member_access`
 * quando o benefício exige prova de posse.
 */
export async function validateClubAccessSession(opts: {
  profileId: string;
  phone: string;
  token: string | null | undefined;
  purposes: ClubOtpPurpose[];
}): Promise<boolean> {
  const phone = digitsPhone(opts.phone);
  const token = String(opts.token || '').trim();
  if (!phone || phone.length < 10 || token.length < 32) return false;

  const variants = phoneVariants(phone);
  const { data } = await supabase
    .from('club_access_sessions')
    .select('id, client_phone, expires_at, purpose')
    .eq('profile_id', opts.profileId)
    .eq('token_hash', hashToken(token))
    .in('purpose', opts.purposes)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (!data) return false;
  const sessionPhone = digitsPhone(String(data.client_phone));
  return variants.includes(sessionPhone) || phoneVariants(sessionPhone).some((v) => variants.includes(v));
}

export function extractClubToken(req: {
  headers?: Record<string, unknown>;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
}): string | null {
  const header =
    (req.headers?.['x-club-token'] as string | undefined) ||
    (req.headers?.['X-Club-Token'] as string | undefined);
  if (header?.trim()) return header.trim();

  const auth = String(req.headers?.authorization || '');
  if (auth.toLowerCase().startsWith('club ')) {
    return auth.slice(5).trim() || null;
  }

  const fromBody = req.body?.club_token ?? req.body?.clubToken;
  if (typeof fromBody === 'string' && fromBody.trim()) return fromBody.trim();

  const fromQuery = req.query?.club_token ?? req.query?.clubToken;
  if (typeof fromQuery === 'string' && fromQuery.trim()) return fromQuery.trim();

  return null;
}
