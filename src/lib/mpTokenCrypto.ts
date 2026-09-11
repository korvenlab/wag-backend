import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const PREFIX = 'enc:v1:';

function encryptionKey(): Buffer | null {
  const raw =
    process.env.MP_TOKEN_ENCRYPTION_KEY?.trim() ||
    process.env.MP_CLIENT_SECRET?.trim() ||
    '';
  if (!raw) return null;
  // 32 bytes via SHA-256 do segredo (aceita qualquer string longa).
  return createHash('sha256').update(raw, 'utf8').digest();
}

/** Criptografa token MP para armazenamento. Sem chave, devolve plaintext. */
export function encryptMpSecret(plain: string | null | undefined): string | null {
  if (plain == null || plain === '') return plain ?? null;
  if (plain.startsWith(PREFIX)) return plain;
  const key = encryptionKey();
  if (!key) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

/** Descriptografa se `enc:v1:…`; senão assume plaintext legado. */
export function decryptMpSecret(stored: string | null | undefined): string | null {
  if (stored == null || stored === '') return stored ?? null;
  if (!stored.startsWith(PREFIX)) return stored;
  const key = encryptionKey();
  if (!key) {
    throw new Error('MP_TOKEN_ENCRYPTION_KEY ausente para ler token criptografado.');
  }
  const body = stored.slice(PREFIX.length);
  const [ivB64, tagB64, dataB64] = body.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Token MP criptografado inválido.');
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function isEncryptedMpSecret(value: string | null | undefined): boolean {
  return Boolean(value && value.startsWith(PREFIX));
}
