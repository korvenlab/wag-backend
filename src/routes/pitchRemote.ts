import { Router, Request, Response } from 'express';

const router = Router();

const VALUE_SLIDES = new Set(['mercado', 'concorrencia', 'margens', 'roadmap']);
const FLUXO_SCENES = new Set([
  'dor-cliente',
  'dor-negocio',
  'canal',
  'solucao',
  'demo',
  'setup',
  'seguranca',
  'outro',
]);

type PitchRemoteState = {
  mode: 'fluxo' | 'valores';
  slide: string;
  updatedAt: number;
  /** Contador monotônico — clientes ignoram snapshots com rev menor. */
  rev: number;
};

let rev = 0;
let state: PitchRemoteState = {
  mode: 'fluxo',
  slide: 'dor-cliente',
  updatedAt: Date.now(),
  rev: 0,
};

function normalize(body: unknown): Omit<PitchRemoteState, 'updatedAt' | 'rev'> | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  const mode = raw.mode === 'valores' ? 'valores' : raw.mode === 'fluxo' ? 'fluxo' : null;
  if (!mode) return null;

  const slideRaw = typeof raw.slide === 'string' ? raw.slide.trim() : '';
  let slide: string;
  if (mode === 'valores') {
    slide = VALUE_SLIDES.has(slideRaw) ? slideRaw : 'mercado';
  } else {
    slide = FLUXO_SCENES.has(slideRaw) ? slideRaw : 'dor-cliente';
  }

  return { mode, slide };
}

/** Estado atual do controle remoto do pitch (público — só para apresentação). */
router.get('/remote', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(state);
});

/** Atualiza o projetor (/pitch) a partir do /pitchnext (ex.: celular). */
router.post('/remote', (req: Request, res: Response) => {
  const next = normalize(req.body);
  if (!next) {
    return res.status(400).json({
      error:
        'Envie { mode: "fluxo"|"valores", slide?: string } (cena do fluxo ou slide de valor).',
    });
  }
  rev += 1;
  state = {
    ...next,
    updatedAt: Date.now(),
    rev,
  };
  res.json(state);
});

export default router;
