export type ProfileMultiBarberRow = {
  multi_barber_plan?: boolean | null;
};

export function profileHasMultiBarberPlan(row: ProfileMultiBarberRow | null | undefined): boolean {
  if (!row) return false;
  const v = row.multi_barber_plan;
  if (v === true) return true;
  if (v === false || v == null) return false;
  if (typeof v === 'string') {
    const s = (v as string).trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'sim' || s === 'yes';
  }
  return Boolean(v);
}
