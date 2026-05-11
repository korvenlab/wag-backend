/**
 * Acesso ao produto Wagoo: assinatura Stripe (`has_paid`) OU cortesia por link (`complimentary_access_until`).
 */

export type ProfileAccessRow = {
  has_paid?: boolean | null;
  complimentary_access_until?: string | null;
};

export function isComplimentaryAccessActive(until: string | null | undefined): boolean {
  if (!until || typeof until !== 'string') return false;
  const t = new Date(until).getTime();
  return Number.isFinite(t) && t > Date.now();
}

export function profileHasWagooAccess(row: ProfileAccessRow | null | undefined): boolean {
  if (!row) return false;
  if (row.has_paid) return true;
  return isComplimentaryAccessActive(row.complimentary_access_until ?? undefined);
}
