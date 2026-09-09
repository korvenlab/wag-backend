import { randomUUID } from 'crypto';
import { supabase } from '../lib/supabase';
import { log } from '../lib/logger';
import { createControlPlaneSignature } from '../lib/controlPlaneSignature';

export type ControlPlaneEventType =
  | 'user.created'
  | 'user.first_login'
  | 'session.started'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'subscription.changed'
  | 'admin.event';

export type ControlPlaneEnvelope = {
  event_id: string;
  event_type: ControlPlaneEventType;
  occurred_at: string;
  product: 'wagoo';
  external_user_id: string;
  organization_id?: string;
  email?: string;
  payload: Record<string, unknown>;
};

export type PublishControlPlaneEventInput = {
  eventId?: string;
  eventType: ControlPlaneEventType;
  occurredAt?: string;
  externalUserId: string;
  organizationId?: string | null;
  email?: string | null;
  payload?: Record<string, unknown>;
  /** Eventos de ciclo de vida usam esta chave para serem enfileirados uma única vez. */
  dedupeKey?: string;
};

type OutboxRow = {
  event_id: string;
  envelope: ControlPlaneEnvelope;
  attempts: number;
};

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_DRAIN_INTERVAL_MS = 5000;
const OUTBOX_BATCH_SIZE = 25;

let drainTimer: NodeJS.Timeout | null = null;
let draining = false;
let immediateDrainScheduled = false;

function configured(): { url: string; secret: string } | null {
  const url = process.env.DASHBOARD_INGEST_URL?.trim();
  const secret = process.env.WAGOO_DASHBOARD_INGEST_SECRET?.trim();
  return url && secret ? { url, secret } : null;
}

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function buildEnvelope(input: PublishControlPlaneEventInput): ControlPlaneEnvelope {
  const envelope: ControlPlaneEnvelope = {
    event_id: input.eventId || randomUUID(),
    event_type: input.eventType,
    occurred_at: input.occurredAt || new Date().toISOString(),
    product: 'wagoo',
    external_user_id: String(input.externalUserId),
    payload: input.payload || {},
  };
  if (input.organizationId) envelope.organization_id = input.organizationId;
  if (input.email) envelope.email = input.email.trim().toLowerCase();
  return envelope;
}

function scheduleImmediateDrain(): void {
  if (immediateDrainScheduled) return;
  immediateDrainScheduled = true;
  setTimeout(() => {
    immediateDrainScheduled = false;
    void drainControlPlaneOutbox();
  }, 0).unref();
}

async function postEnvelope(envelope: ControlPlaneEnvelope): Promise<void> {
  const target = configured();
  if (!target) throw new Error('DASHBOARD_INGEST_URL/WAGOO_DASHBOARD_INGEST_SECRET não configurados');

  const rawBody = JSON.stringify(envelope);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createControlPlaneSignature(timestamp, rawBody, target.secret);
  const timeoutMs = positiveInt(
    process.env.DASHBOARD_INGEST_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    10_000,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-korven-product': 'wagoo',
        'x-korven-timestamp': timestamp,
        'x-korven-signature': signature,
      },
      body: rawBody,
      signal: controller.signal,
    });
    if (!response.ok) {
      const responseBody = (await response.text()).slice(0, 500);
      throw new Error(`ingest HTTP ${response.status}: ${responseBody}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function postWithShortRetry(envelope: ControlPlaneEnvelope): Promise<void> {
  const maxAttempts = positiveInt(
    process.env.DASHBOARD_INGEST_MAX_ATTEMPTS,
    DEFAULT_MAX_ATTEMPTS,
    5,
  );
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await postEnvelope(envelope);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 200));
      }
    }
  }
  throw lastError;
}

async function enqueue(envelope: ControlPlaneEnvelope, dedupeKey?: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('wagoo_enqueue_control_plane_event', {
    p_event: envelope,
    p_dedupe_key: dedupeKey || null,
  });
  if (!error) return data !== false;

  // Compatibilidade durante rollout: tenta inserir sem depender da função RPC.
  const { error: insertError } = await supabase.from('wagoo_control_plane_outbox').insert({
    event_id: envelope.event_id,
    event_type: envelope.event_type,
    external_user_id: envelope.external_user_id,
    dedupe_key: dedupeKey || null,
    envelope,
  });
  if (!insertError) return true;
  if (insertError.code === '23505') return false;
  throw new Error(`outbox indisponível: ${insertError.message}; rpc: ${error.message}`);
}

/**
 * Enfileira de forma assíncrona. Chamadores de signup/login/webhook não aguardam esta Promise:
 * falhas ficam no outbox e o worker as drena; antes da migration há fallback HTTP best-effort.
 */
export async function publishControlPlaneEvent(
  input: PublishControlPlaneEventInput,
): Promise<void> {
  if (!configured()) {
    log.warn('CONTROL_PLANE', 'publisher desabilitado: configuração ausente', {
      eventType: input.eventType,
      externalUserId: input.externalUserId,
    });
    return;
  }

  const envelope = buildEnvelope(input);
  try {
    const inserted = await enqueue(envelope, input.dedupeKey);
    if (inserted) scheduleImmediateDrain();
  } catch (outboxError) {
    try {
      await postWithShortRetry(envelope);
    } catch (sendError) {
      log.error('CONTROL_PLANE', 'evento perdido após fallback best-effort', sendError, {
        eventId: envelope.event_id,
        eventType: envelope.event_type,
        externalUserId: envelope.external_user_id,
        outboxError: outboxError instanceof Error ? outboxError.message : String(outboxError),
      });
    }
  }
}

async function claimOutboxBatch(): Promise<OutboxRow[]> {
  const { data, error } = await supabase.rpc('wagoo_claim_control_plane_events', {
    p_limit: OUTBOX_BATCH_SIZE,
  });
  if (error) throw error;
  return ((data || []) as Array<Record<string, unknown>>).map((row) => ({
    event_id: String(row.event_id),
    envelope: row.envelope as ControlPlaneEnvelope,
    attempts: Number(row.attempts) || 1,
  }));
}

async function markDelivered(eventId: string): Promise<void> {
  const { error } = await supabase
    .from('wagoo_control_plane_outbox')
    .update({ delivered_at: new Date().toISOString(), lease_until: null, last_error: null })
    .eq('event_id', eventId);
  if (error) throw error;
}

async function releaseForRetry(row: OutboxRow, error: unknown): Promise<void> {
  const delaySeconds = Math.min(300, Math.max(5, 2 ** Math.min(row.attempts, 8)));
  const nextAttemptAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
  const message = error instanceof Error ? error.message : String(error);
  const { error: updateError } = await supabase
    .from('wagoo_control_plane_outbox')
    .update({
      next_attempt_at: nextAttemptAt,
      lease_until: null,
      last_error: message.slice(0, 2000),
    })
    .eq('event_id', row.event_id);
  if (updateError) {
    log.error('CONTROL_PLANE', 'falha ao liberar evento para retry', updateError, {
      eventId: row.event_id,
    });
  }
}

export async function drainControlPlaneOutbox(): Promise<void> {
  if (draining || !configured()) return;
  draining = true;
  try {
    const rows = await claimOutboxBatch();
    for (const row of rows) {
      try {
        await postWithShortRetry(row.envelope);
        await markDelivered(row.event_id);
      } catch (error) {
        await releaseForRetry(row, error);
        log.warn('CONTROL_PLANE', 'entrega adiada', {
          eventId: row.event_id,
          eventType: row.envelope.event_type,
          attempts: row.attempts,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    log.error('CONTROL_PLANE', 'worker outbox falhou', error);
  } finally {
    draining = false;
  }
}

export function startControlPlanePublisher(): void {
  if (drainTimer || !configured()) return;
  const intervalMs = positiveInt(
    process.env.DASHBOARD_INGEST_DRAIN_INTERVAL_MS,
    DEFAULT_DRAIN_INTERVAL_MS,
    60_000,
  );
  drainTimer = setInterval(() => void drainControlPlaneOutbox(), intervalMs);
  drainTimer.unref();
  scheduleImmediateDrain();
  log.info('CONTROL_PLANE', 'worker outbox iniciado', { intervalMs });
}
