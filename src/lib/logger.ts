/**
 * Logs padronizados para o Render (stdout/stderr).
 * Prefixo [WAGOO <SCOPE>] facilita filtrar no dashboard.
 */

export type LogMeta = Record<string, unknown>;

function fmt(scope: string, message: string, meta?: LogMeta): string {
  const base = `[WAGOO ${scope}] ${message}`;
  if (!meta || Object.keys(meta).length === 0) return base;
  try {
    return `${base} | ${JSON.stringify(meta)}`;
  } catch {
    return base;
  }
}

function errDetail(err: unknown): LogMeta {
  if (err instanceof Error) {
    return { error: err.message, stack: err.stack?.split('\n').slice(0, 4).join(' | ') };
  }
  return { error: String(err) };
}

export const log = {
  info(scope: string, message: string, meta?: LogMeta): void {
    console.log(fmt(scope, message, meta));
  },
  warn(scope: string, message: string, meta?: LogMeta): void {
    console.warn(fmt(scope, message, meta));
  },
  error(scope: string, message: string, errOrMeta?: unknown, meta?: LogMeta): void {
    if (errOrMeta == null || errOrMeta instanceof Error || typeof errOrMeta === 'string') {
      console.error(fmt(scope, message, { ...errDetail(errOrMeta), ...meta }));
      return;
    }
    if (typeof errOrMeta === 'object' && errOrMeta !== null && 'message' in errOrMeta) {
      const m = (errOrMeta as { message?: unknown }).message;
      console.error(fmt(scope, message, { error: m != null ? String(m) : String(errOrMeta), ...meta }));
      return;
    }
    console.error(fmt(scope, message, { ...(errOrMeta as LogMeta), ...meta }));
  },
  /** Passo explícito de fluxo (ex.: QR → sync → open). */
  step(scope: string, step: string, meta?: LogMeta): void {
    console.log(fmt(scope, `→ ${step}`, meta));
  },
};
