export const BUSINESS_NICHE_IDS = [
  'barbearia',
  'salao',
  'manicure',
  'estetica',
  'outro',
] as const;

export type BusinessNicheId = (typeof BUSINESS_NICHE_IDS)[number];

export type NicheVocabulary = {
  id: BusinessNicheId;
  label: string;
  businessType: string;
  professional: string;
  professionals: string;
  defaultStoreName: string;
};

const NICHE_BASE: Record<BusinessNicheId, Omit<NicheVocabulary, 'id' | 'label'> & { label: string }> = {
  barbearia: {
    label: 'Barbearia',
    businessType: 'barbearia',
    professional: 'barbeiro',
    professionals: 'barbeiros',
    defaultStoreName: 'Barbearia',
  },
  salao: {
    label: 'Salão de beleza',
    businessType: 'salão de beleza',
    professional: 'profissional',
    professionals: 'profissionais',
    defaultStoreName: 'Salão',
  },
  manicure: {
    label: 'Manicure / unhas',
    businessType: 'estúdio de manicure',
    professional: 'manicure',
    professionals: 'profissionais',
    defaultStoreName: 'Estúdio de unhas',
  },
  estetica: {
    label: 'Estética',
    businessType: 'clínica de estética',
    professional: 'profissional',
    professionals: 'profissionais',
    defaultStoreName: 'Estética',
  },
  outro: {
    label: 'Outro',
    businessType: 'estabelecimento',
    professional: 'profissional',
    professionals: 'profissionais',
    defaultStoreName: 'Loja',
  },
};

export function isBusinessNicheId(value: unknown): value is BusinessNicheId {
  return typeof value === 'string' && (BUSINESS_NICHE_IDS as readonly string[]).includes(value);
}

export function resolveNicheVocabulary(
  niche: unknown,
  customLabel?: unknown,
): NicheVocabulary {
  const id: BusinessNicheId = isBusinessNicheId(niche) ? niche : 'outro';
  const base = NICHE_BASE[id];
  const custom =
    typeof customLabel === 'string' && customLabel.trim() ? customLabel.trim() : null;

  if (id === 'outro' && custom) {
    return {
      id,
      label: custom,
      businessType: custom.toLowerCase(),
      professional: 'profissional',
      professionals: 'profissionais',
      defaultStoreName: custom,
    };
  }

  return { id, ...base };
}
