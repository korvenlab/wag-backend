import express, { NextFunction, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { getUserFromBearerHeader } from '../lib/supabaseAuthUser';

const router = express.Router();

type ApiErrorCode =
  | 'UNAUTHORIZED'
  | 'VALIDATION_ERROR'
  | 'INTERNAL_ERROR'
  | 'UNAVAILABLE'
  | 'NOT_FOUND';

const JSON_UTF8 = 'application/json; charset=utf-8';

function sendApiError(
  res: Response,
  status: number,
  code: ApiErrorCode,
  error: string
): void {
  res.status(status).type(JSON_UTF8).json({ ok: false, error, code });
}

/** Mesmo valor enviado como `WAGOO_METRICS_API_KEY` no dashboard Korven. */
function getUpstreamSecret(): string {
  return (
    process.env.ADMIN_API_SECRET ||
    process.env.API_SECRET ||
    process.env.METRICS_API_KEY ||
    ''
  ).trim();
}

function extractProvidedSecret(req: Request): string | undefined {
  const auth = req.headers.authorization;
  const bearer =
    typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')
      ? auth.slice(7).trim()
      : undefined;
  const apiKeyRaw = req.headers['x-api-key'];
  const apiKey = Array.isArray(apiKeyRaw) ? apiKeyRaw[0]?.trim() : apiKeyRaw?.trim();
  const legacyRaw = req.headers['x-admin-secret'];
  const legacy = Array.isArray(legacyRaw) ? legacyRaw[0]?.trim() : legacyRaw?.trim();
  const pick = bearer || apiKey || legacy;
  return pick && pick.length > 0 ? pick : undefined;
}

function requireUpstreamAuth(req: Request, res: Response, next: NextFunction): void {
  const configured = getUpstreamSecret();
  if (!configured) {
    sendApiError(
      res,
      503,
      'UNAVAILABLE',
      'Segredo não configurado (ADMIN_API_SECRET, API_SECRET ou METRICS_API_KEY).'
    );
    return;
  }
  const provided = extractProvidedSecret(req);
  if (!provided || provided !== configured) {
    sendApiError(res, 401, 'UNAUTHORIZED', 'API Key inválida ou ausente.');
    return;
  }
  next();
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function dashboardFeedbackIngestUrl(): string {
  const explicit = (process.env.DASHBOARD_FEEDBACK_INGEST_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return 'https://dashboard.korvenlab.com/api/dashboard/ingest/feedback';
}

/**
 * App autenticado: grava no Supabase central do dashboard (não no banco Wagoo).
 * POST /feedback/messages  Authorization: Bearer <access_token>
 */
router.post('/messages', async (req: Request, res: Response) => {
  try {
    const auth = await getUserFromBearerHeader(supabase, req.headers.authorization);
    if (!auth.ok) {
      sendApiError(res, 401, 'UNAUTHORIZED', 'Sessão inválida ou ausente.');
      return;
    }

    const bodyRaw = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (bodyRaw.length < 5 || bodyRaw.length > 8000) {
      sendApiError(
        res,
        400,
        'VALIDATION_ERROR',
        'body deve ter entre 5 e 8000 caracteres.',
      );
      return;
    }

    const secret = getUpstreamSecret();
    if (!secret) {
      sendApiError(
        res,
        503,
        'UNAVAILABLE',
        'Segredo de ingestão não configurado no wag-backend.',
      );
      return;
    }

    const user = auth.user;
    const fullName =
      typeof req.body?.user_full_name === 'string'
        ? req.body.user_full_name.trim().slice(0, 200)
        : typeof user.user_metadata?.name === 'string'
          ? String(user.user_metadata.name).trim().slice(0, 200)
          : null;

    const payload = {
      source: 'wagoo' as const,
      external_user_id: user.id,
      organization_id:
        typeof req.body?.organization_id === 'string'
          ? req.body.organization_id.trim() || null
          : null,
      user_email: user.email ? String(user.email).trim().toLowerCase() : null,
      user_full_name: fullName || null,
      body: bodyRaw,
    };

    const ingestUrl = dashboardFeedbackIngestUrl();
    const upstream = await fetch(ingestUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${secret}`,
        'X-API-Key': secret,
        'x-admin-secret': secret,
      },
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    const root =
      json && typeof json === 'object' && !Array.isArray(json)
        ? (json as Record<string, unknown>)
        : {};

    if (!upstream.ok || root.ok === false) {
      const msg =
        typeof root.error === 'string'
          ? root.error
          : `Falha ao enviar ao dashboard (HTTP ${upstream.status}).`;
      sendApiError(res, 502, 'UNAVAILABLE', msg);
      return;
    }

    res.status(201).type(JSON_UTF8).json({
      ok: true as const,
      data: root.data ?? null,
    });
  } catch (e: unknown) {
    sendApiError(res, 503, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
});

/** Lista mensagens legadas no banco Wagoo (sync histórico para o Korven). */
router.get('/messages', requireUpstreamAuth, async (req: Request, res: Response) => {
  const rawLimit = req.query.limit;
  const limit = Math.min(500, Math.max(1, parseInt(String(rawLimit ?? '200'), 10) || 200));

  try {
    const { data, error } = await supabase
      .from('feedback_messages')
      .select('id,created_at,user_id,organization_id,user_email,user_full_name,body')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      sendApiError(res, 502, 'UNAVAILABLE', error.message);
      return;
    }

    res.status(200).type(JSON_UTF8).json({
      ok: true as const,
      data: data ?? [],
    });
  } catch (e: unknown) {
    sendApiError(res, 503, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
});

router.delete('/messages/:id', requireUpstreamAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id || '').trim();
  if (!UUID_RE.test(id)) {
    sendApiError(res, 400, 'VALIDATION_ERROR', 'id da mensagem inválido (UUID).');
    return;
  }

  try {
    const { error, count } = await supabase
      .from('feedback_messages')
      .delete({ count: 'exact' })
      .eq('id', id);
    if (error) {
      sendApiError(res, 502, 'UNAVAILABLE', error.message);
      return;
    }
    if ((count ?? 0) < 1) {
      sendApiError(res, 404, 'NOT_FOUND', 'Mensagem não encontrada.');
      return;
    }

    res.status(200).type(JSON_UTF8).json({ ok: true as const, data: { id, deleted: true as const } });
  } catch (e: unknown) {
    sendApiError(res, 503, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
});

export default router;
