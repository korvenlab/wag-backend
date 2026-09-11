import { createHmac, timingSafeEqual } from 'crypto';

/** Janela padrão anti-replay (5 min). */
export const MP_WEBHOOK_MAX_SKEW_SEC = 300;

export function parseMercadoPagoSignature(
  xSignature: string | undefined,
): { ts: string; v1: string } | null {
  if (!xSignature) return null;
  const parts = Object.fromEntries(
    xSignature.split(',').map((chunk) => {
      const [k, ...rest] = chunk.trim().split('=');
      return [k.trim(), rest.join('=').trim()];
    }),
  );
  if (!parts.ts || !parts.v1) return null;
  return { ts: parts.ts, v1: parts.v1 };
}

/**
 * Valida x-signature do Mercado Pago (Webhooks).
 * Manifest: id:[data.id];request-id:[x-request-id];ts:[ts];
 * Opcionalmente rejeita timestamps fora da janela (anti-replay).
 */
export function verifyMercadoPagoWebhookSignature(input: {
  xSignature: string | undefined;
  xRequestId: string | undefined;
  dataId: string | undefined;
  secret: string;
  /** Epoch seconds agora; default Date.now()/1000 */
  nowSec?: number;
  maxSkewSec?: number;
}): boolean {
  const secret = input.secret.trim();
  if (!secret || !input.xSignature) return false;

  const parts = parseMercadoPagoSignature(input.xSignature);
  if (!parts) return false;
  const { ts, v1 } = parts;

  const maxSkew = input.maxSkewSec ?? MP_WEBHOOK_MAX_SKEW_SEC;
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > maxSkew) {
    return false;
  }

  const manifestParts: string[] = [];
  if (input.dataId) {
    manifestParts.push(`id:${String(input.dataId).toLowerCase()}`);
  }
  if (input.xRequestId) {
    manifestParts.push(`request-id:${input.xRequestId}`);
  }
  manifestParts.push(`ts:${ts}`);
  const manifest = `${manifestParts.join(';')};`;

  const computed = createHmac('sha256', secret).update(manifest).digest('hex');
  try {
    const a = Buffer.from(computed, 'utf8');
    const b = Buffer.from(v1, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
