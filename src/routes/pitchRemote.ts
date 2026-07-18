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
};

let state: PitchRemoteState = {
  mode: 'fluxo',
  slide: 'dor-cliente',
  updatedAt: Date.now(),
};

function normalize(body: unknown): PitchRemoteState | null {
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

  return { mode, slide, updatedAt: Date.now() };
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
  state = next;
  res.json(state);
});

export default router;
