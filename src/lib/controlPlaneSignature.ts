import crypto from 'crypto';

export function createControlPlaneSignature(
  timestamp: string,
  rawBody: string,
  secret: string,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}
