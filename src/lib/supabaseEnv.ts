/**
 * Remove artefactos comuns de copy-paste em ficheiros `.env` (aspas, `\n` literal, newline final).
 * Crítico para JWTs (ex.: `SUPABASE_SERVICE_ROLE_KEY`) que deixam de autenticar com um único caracter extra.
 */
export function cleanEnvString(value: string | undefined): string {
  if (value === undefined || value === null) return '';
  let s = String(value).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/\\n$/g, '').replace(/\n$/g, '').replace(/\r$/g, '').trim();
  return s;
}
