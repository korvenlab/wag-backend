import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Valida x-signature do Mercado Pago (Webhooks).
 * Manifest: id:[data.id];request-id:[x-request-id];ts:[ts];
 */
export function verifyMercadoPagoWebhookSignature(input: {
  xSignature: string | undefined;
  xRequestId: string | undefined;
  dataId: string | undefined;
  secret: string;
}): boolean {
  const secret = input.secret.trim();
  if (!secret || !input.xSignature) return false;

  const parts = Object.fromEntries(
    input.xSignature.split(',').map((chunk) => {
      const [k, ...rest] = chunk.trim().split('=');
      return [k.trim(), rest.join('=').trim()];
    }),
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

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
