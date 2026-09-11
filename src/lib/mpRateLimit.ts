type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/**
 * Rate limit simples em memória (ok em 1 instância Render).
 * Retorna true se a requisição deve ser bloqueada.
 */
export function isRateLimited(
  key: string,
  opts: { limit: number; windowMs: number } = { limit: 20, windowMs: 60_000 },
): boolean {
  const now = Date.now();
  const cur = buckets.get(key);
  if (!cur || cur.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    return false;
  }
  cur.count += 1;
  if (cur.count > opts.limit) return true;
  return false;
}

export function clientIp(req: { ip?: string; headers: Record<string, unknown> }): string {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  if (Array.isArray(xf) && typeof xf[0] === 'string') return xf[0].split(',')[0].trim();
  return req.ip || 'unknown';
}
