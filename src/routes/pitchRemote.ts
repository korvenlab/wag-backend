import { Router, Request, Response } from 'express';

const router = Router();

const VALUE_SLIDES = new Set(['mercado', 'concorrencia', 'margens', 'roadmap']);

type PitchRemoteState = {
  mode: 'fluxo' | 'valores';
  slide: string;
  updatedAt: number;
};

let state: PitchRemoteState = {
  mode: 'fluxo',
  slide: 'mercado',
  updatedAt: Date.now(),
};

function normalize(body: unknown): PitchRemoteState | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  const mode = raw.mode === 'valores' ? 'valores' : raw.mode === 'fluxo' ? 'fluxo' : null;
  if (!mode) return null;
  const slideRaw = typeof raw.slide === 'string' ? raw.slide : 'mercado';
  const slide = VALUE_SLIDES.has(slideRaw) ? slideRaw : 'mercado';
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
    return res.status(400).json({ error: 'Envie { mode: "fluxo"|"valores", slide?: string }.' });
  }
  state = next;
  res.json(state);
});

export default router;
