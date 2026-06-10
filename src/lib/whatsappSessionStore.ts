import fs from 'fs';
import path from 'path';
import { supabase } from './supabase';

export const WHATSAPP_SESSION_BUNDLE_VERSION = 2;

export type WhatsAppSessionBundleV2 = {
  v: typeof WHATSAPP_SESSION_BUNDLE_VERSION;
  files: Record<string, string>;
  updatedAt: string;
};

export function isSessionBundleV2(data: unknown): data is WhatsAppSessionBundleV2 {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as WhatsAppSessionBundleV2).v === WHATSAPP_SESSION_BUNDLE_VERSION &&
    typeof (data as WhatsAppSessionBundleV2).files === 'object' &&
    (data as WhatsAppSessionBundleV2).files !== null
  );
}

/** Baileys multi-file: creds.json + chaves de sessão/pre-key. */
export function sessionDirLooksComplete(sessionDir: string): boolean {
  if (!fs.existsSync(sessionDir)) return false;
  const entries = fs.readdirSync(sessionDir).filter((n) => !n.startsWith('.'));
  if (!entries.includes('creds.json')) return false;
  return entries.some(
    (n) =>
      n.startsWith('session-') ||
      n.startsWith('pre-key-') ||
      n.startsWith('sender-key-') ||
      n.startsWith('app-state-sync-key-'),
  );
}

export function bundleLooksComplete(stored: unknown): boolean {
  if (!isSessionBundleV2(stored)) return false;
  const names = Object.keys(stored.files);
  if (!names.includes('creds.json')) return false;
  return names.some(
    (n) =>
      n.startsWith('session-') ||
      n.startsWith('pre-key-') ||
      n.startsWith('sender-key-') ||
      n.startsWith('app-state-sync-key-'),
  );
}

export function readAllSessionFilesFromDisk(sessionDir: string): Record<string, string> {
  if (!fs.existsSync(sessionDir)) return {};
  const files: Record<string, string> = {};
  for (const name of fs.readdirSync(sessionDir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(sessionDir, name);
    if (!fs.statSync(full).isFile()) continue;
    files[name] = fs.readFileSync(full, 'utf-8');
  }
  return files;
}

export function writeAllSessionFilesToDisk(sessionDir: string, files: Record<string, string>): void {
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const safeName = path.basename(name);
    if (safeName !== name || safeName.includes('..')) continue;
    if (!safeName.endsWith('.json')) continue;
    fs.writeFileSync(path.join(sessionDir, safeName), content, 'utf-8');
  }
}

export function packSessionForSupabase(sessionDir: string): WhatsAppSessionBundleV2 | null {
  const files = readAllSessionFilesFromDisk(sessionDir);
  if (!files['creds.json']?.trim()) return null;
  return {
    v: WHATSAPP_SESSION_BUNDLE_VERSION,
    files,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Restaura pasta auth do Baileys a partir do Supabase.
 * @returns true se o bundle v2 estava completo e foi escrito no disco.
 */
export function restoreWhatsAppSessionToDisk(sessionDir: string, stored: unknown): boolean {
  if (isSessionBundleV2(stored)) {
    writeAllSessionFilesToDisk(sessionDir, stored.files);
    return sessionDirLooksComplete(sessionDir);
  }

  // Legado: só creds.json (formato antigo) — incompleto para auto-reconnect.
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'creds.json'),
      JSON.stringify(stored),
      'utf-8',
    );
  }
  return false;
}

const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PERSIST_DEBOUNCE_MS = 2500;

export function schedulePersistWhatsAppSession(email: string, sessionDir: string): void {
  const prev = persistTimers.get(email);
  if (prev) clearTimeout(prev);
  persistTimers.set(
    email,
    setTimeout(() => {
      persistTimers.delete(email);
      void persistWhatsAppSessionToSupabase(email, sessionDir);
    }, PERSIST_DEBOUNCE_MS),
  );
}

export async function persistWhatsAppSessionToSupabase(
  email: string,
  sessionDir: string,
): Promise<void> {
  const bundle = packSessionForSupabase(sessionDir);
  if (!bundle) return;

  const { error } = await supabase
    .from('profiles')
    .update({ whatsapp_session: bundle })
    .eq('email', email);

  if (error) {
    console.error(`[WAGOO WA] Falha ao persistir sessão (${email}):`, error.message);
    return;
  }

  console.log(
    `[WAGOO WA] Sessão persistida no Supabase (${email}, ${Object.keys(bundle.files).length} ficheiros)`,
  );
}

export async function clearWhatsAppSessionInSupabase(email: string): Promise<void> {
  const pending = persistTimers.get(email);
  if (pending) {
    clearTimeout(pending);
    persistTimers.delete(email);
  }
  await supabase.from('profiles').update({ whatsapp_session: null }).eq('email', email);
}
