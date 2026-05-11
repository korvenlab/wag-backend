/**
 * Acesso ao produto Wagoo: assinatura Stripe (`has_paid`) OU cortesia por link (`complimentary_access_until`).
 */

export type ProfileAccessRow = {
  /** Valor cru de `profiles.has_paid` (boolean, texto manual, bigint, etc.). */
  has_paid?: unknown;
  /** Valor cru da coluna (ISO, epoch segundos/ms, etc.). */
  complimentary_access_until?: unknown;
};

/** Epoch em segundos (PostgREST / JSON às vezes devolve número ~1e9–1e10). */
function epochNumberToMillis(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return NaN;
  if (n < 10_000_000_000) return Math.round(n * 1000);
  return Math.round(n);
}

/** Converte `complimentary_access_until` vindo do PostgREST / cliente (string, Date, ms) em epoch ms ou null. */
export function complimentaryUntilToMillis(until: unknown): number | null {
  if (until === null || until === undefined) return null;
  if (typeof until === 'string') {
    const s = until.trim();
    if (!s) return null;
    const fromIso = new Date(s).getTime();
    if (Number.isFinite(fromIso)) return fromIso;
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) {
      const ms = epochNumberToMillis(n);
      return Number.isFinite(ms) ? ms : null;
    }
    return null;
  }
  if (typeof until === 'number' && Number.isFinite(until) && until > 0) {
    const ms = epochNumberToMillis(until);
    return Number.isFinite(ms) ? ms : null;
  }
  if (until instanceof Date) {
    const t = until.getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export function isComplimentaryAccessActive(until: string | null | undefined | unknown): boolean {
  const ms = complimentaryUntilToMillis(until);
  return ms != null && ms > Date.now();
}

/** Normaliza `has_paid` vindo do Postgres / edições manuais (texto, bigint, etc.). */
export function rowHasPaidTrue(v: unknown): boolean {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  if (typeof v === 'bigint') return v !== 0n;
  if (typeof v === 'number' && Number.isFinite(v)) return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (
      ['true', 't', '1', 'yes', 'sim', 'pago', 'verdadeiro', 'ligado', 'ativo', 'on'].includes(s)
    )
      return true;
    if (
      ['false', 'f', '0', 'no', 'n', 'não', 'nao', 'falso', 'desligado', 'inativo', 'off'].includes(s)
    )
      return false;
  }
  return false;
}

export function profileHasWagooAccess(row: ProfileAccessRow | null | undefined): boolean {
  if (!row) return false;
  if (rowHasPaidTrue(row.has_paid)) return true;
  return isComplimentaryAccessActive(row.complimentary_access_until);
}
