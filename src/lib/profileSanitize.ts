const SECRET_PROFILE_KEYS = new Set([
  'whatsapp_session',
  'googleAuth',
  'google_auth',
]);

/**
 * Remove segredos do perfil e expõe só flags de conexão para o front.
 */
export function sanitizeProfileForClient(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (SECRET_PROFILE_KEYS.has(key)) continue;
    out[key] = value;
  }

  const wa = row.whatsapp_session;
  out.whatsapp_connected = wa != null && wa !== '' && wa !== false;

  const google = row.googleAuth as { refreshToken?: string | null } | null | undefined;
  out.google_connected = Boolean(google && google.refreshToken);

  return out;
}
