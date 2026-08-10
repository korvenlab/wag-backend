import express, { Router, Request, Response } from 'express';
import { handleAsaasClubWebhookPayload } from '../services/clubMembership';
import { log } from '../lib/logger';

const router = Router();

/**
 * Webhook Asaas (conta plataforma).
 * Configure no painel Asaas: URL https://<api>/api/asaas/webhook
 * Eventos: PAYMENT_RECEIVED, PAYMENT_CONFIRMED
 * Header obrigatório: asaas-access-token = ASAAS_WEBHOOK_TOKEN
 */
router.post('/webhook', express.json({ limit: '2mb' }), async (req: Request, res: Response) => {
  const expected = String(process.env.ASAAS_WEBHOOK_TOKEN || '').trim();
  if (!expected) {
    log.error('ASAAS', 'ASAAS_WEBHOOK_TOKEN não configurado — webhook recusado');
    return res.status(503).json({ error: 'Webhook não configurado.' });
  }

  const got =
    String(req.headers['asaas-access-token'] || '') ||
    String(req.query.token || '');
  if (got !== expected) {
    log.warn('ASAAS', 'webhook token inválido');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await handleAsaasClubWebhookPayload({
      event: req.body?.event,
      payment: req.body?.payment,
    });
    res.json({ received: true });
  } catch (err) {
    log.error('ASAAS', 'webhook falhou', err);
    res.status(500).json({ error: 'webhook_error' });
  }
});

export default router;
