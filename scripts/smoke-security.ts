import assert from 'assert';
import { createGoogleOAuthState, verifyGoogleOAuthState } from '../src/lib/googleOAuthState';
import { sanitizeProfileForClient } from '../src/lib/profileSanitize';

const state = createGoogleOAuthState('user-1', 'loja@example.com', 600);
const ok = verifyGoogleOAuthState(state);
assert.equal(ok.ok, true);
if (ok.ok) {
  assert.equal(ok.payload.sub, 'user-1');
  assert.equal(ok.payload.email, 'loja@example.com');
}

assert.equal(verifyGoogleOAuthState(state.slice(0, -2) + 'xx').ok, false);
assert.equal(verifyGoogleOAuthState('not-a-state').ok, false);

const safe = sanitizeProfileForClient({
  id: '1',
  email: 'a@b.com',
  store_name: 'Studio',
  whatsapp_session: { creds: 'SECRET' },
  googleAuth: { refreshToken: 'rt', accessToken: 'at' },
});
assert.equal('whatsapp_session' in safe, false);
assert.equal('googleAuth' in safe, false);
assert.equal(safe.whatsapp_connected, true);
assert.equal(safe.google_connected, true);
assert.equal(safe.store_name, 'Studio');

const empty = sanitizeProfileForClient({ id: '2', googleAuth: {} });
assert.equal(empty.whatsapp_connected, false);
assert.equal(empty.google_connected, false);

console.log('ok: oauth state + profile sanitize');
