const crypto = require('crypto');
const assert = require('assert');

function signingKey() {
  return process.env.GOOGLE_OAUTH_STATE_SECRET || process.env.GOOGLE_CLIENT_SECRET || 'wagoo-dev-oauth-state';
}
function b64url(input) {
  return Buffer.from(input).toString('base64url');
}
function sign(payloadB64) {
  return crypto.createHmac('sha256', signingKey()).update(payloadB64).digest('base64url');
}
function createState(userId, email, ttlSec = 600) {
  const payload = { sub: userId, email: email.toLowerCase(), exp: Math.floor(Date.now() / 1000) + ttlSec };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}
function verifyState(state) {
  if (typeof state !== 'string' || !state.includes('.')) return false;
  const [payloadB64, sig] = state.split('.', 2);
  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  return payload.sub === 'user-1' && payload.email === 'loja@example.com';
}

const state = createState('user-1', 'loja@example.com');
assert.equal(verifyState(state), true);
assert.equal(verifyState(state.slice(0, -2) + 'xx'), false);

const SECRET = new Set(['whatsapp_session', 'googleAuth', 'google_auth']);
function sanitize(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (!SECRET.has(k)) out[k] = v;
  }
  out.whatsapp_connected = row.whatsapp_session != null && row.whatsapp_session !== '';
  out.google_connected = Boolean(row.googleAuth && row.googleAuth.refreshToken);
  return out;
}
const safe = sanitize({
  store_name: 'Studio',
  whatsapp_session: { creds: 'SECRET' },
  googleAuth: { refreshToken: 'rt' },
});
assert.equal(safe.whatsapp_session, undefined);
assert.equal(safe.googleAuth, undefined);
assert.equal(safe.whatsapp_connected, true);
assert.equal(safe.google_connected, true);

console.log('ok: oauth state + profile sanitize');
