/**
 * Acesso ao produto Wagoo: assinatura Stripe (`has_paid`) OU cortesia por link (`complimentary_access_until`).
 */

export type ProfileAccessRow = {
  /** Valor cru de `profiles.has_paid` (boolean, texto manual, bigint, etc.). */
  has_paid?: unknown;
  complimentary_access_until?: string | null;
};

export function isComplimentaryAccessActive(until: string | null | undefined): boolean {
  if (!until || typeof until !== 'string') return false;
  const t = new Date(until).getTime();
  return Number.isFinite(t) && t > Date.now();
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
  return isComplimentaryAccessActive(row.complimentary_access_until ?? undefined);
}
