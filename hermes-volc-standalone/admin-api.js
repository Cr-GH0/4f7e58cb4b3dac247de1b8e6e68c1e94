import { checkPassword, readTicket, signTicket } from './admin-security.js';
import { defaultSettings, validateSettings } from './public/model-settings.js';
import { modelCatalog } from './model-catalog.js';

// Behind a reverse proxy the browser's Origin is the public https domain while the
// request URL may be rebuilt from internal Host values. Compare hosts, accepting
// every host identity the proxy chain provides; cross-site origins still fail.
// Origins on the WorkBuddy publish platform itself (*.app.workbuddy.link) are also
// accepted: publish links always live there, and cookies are host-only + SameSite,
// so a sibling app can never carry this site's credentials.
const PLATFORM_SUFFIX = '.app.workbuddy.link';

// Same idea as the student login throttle: slow down online guessing of the
// admin password without persistent state.
const LOGIN_MAX_FAILURES = 5, LOGIN_LOCK_MS = 30_000;
let loginFailures = 0, loginLockedUntil = 0;
const originAllowed = (request, url) => {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  let originHost = '';
  try { originHost = new URL(origin).host.toLowerCase(); } catch { return false; }
  if (originHost.endsWith(PLATFORM_SUFFIX)) return true;
  const hosts = new Set();
  for (const value of [url.host, request.headers.get('Host'), request.headers.get('X-Forwarded-Host')]) {
    for (const piece of String(value ?? '').toLowerCase().split(',')) {
      const host = piece.trim();
      if (host) hosts.add(host);
    }
  }
  return hosts.has(originHost);
};

export async function adminRequest(request, store, password, credentials) {
  const url = new URL(request.url), path = url.pathname;
  const headers = { 'Cache-Control': 'no-store' };
  const json = (data, status = 200, extra = {}) => Response.json(data, { status, headers: { ...headers, ...extra } });
  const cookie = (value, age) => `hermes_admin=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${age}${url.protocol === 'https:' ? '; Secure' : ''}`;
  try {
    if (!password) return json({ error: 'An admin password has not been configured.' }, 503);
    if (request.method !== 'GET' && !originAllowed(request, url)) return json({ error: 'Submit changes from Mimi Admin settings.' }, 403);
    if (path === '/api/admin/login' && request.method === 'POST') {
      if (Date.now() < loginLockedUntil) return json({ error: 'Too many attempts. Try again in a moment.' }, 429);
      const input = await request.json();
      if (!await checkPassword(input.password, password)) {
        loginFailures += 1;
        if (loginFailures >= LOGIN_MAX_FAILURES) { loginLockedUntil = Date.now() + LOGIN_LOCK_MS; loginFailures = 0; }
        return json({ error: 'Incorrect password.' }, 401);
      }
      loginFailures = 0;
      const ticket = await signTicket({ purpose: 'admin', expiresAt: Date.now() + 8 * 60 * 60 * 1000, nonce: crypto.randomUUID() }, password);
      return json({ ok: true }, 200, { 'Set-Cookie': cookie(ticket, 8 * 60 * 60) });
    }
    const raw = request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('hermes_admin='))?.slice('hermes_admin='.length);
    if (!await readTicket(raw, password, 'admin')) return json({ error: 'Sign in to Admin settings first.' }, 401);
    if (path === '/api/admin/catalog' && request.method === 'GET') return json(await modelCatalog(credentials, url.searchParams.get('refresh') === '1'));
    if (path === '/api/admin/logout' && request.method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
    if (path === '/api/admin/settings' && request.method === 'GET') return json({ ...await store.current(), defaults: defaultSettings() });
    if (path === '/api/admin/settings' && request.method === 'PUT') {
      const input = await request.json();
      if (!Number.isInteger(input.revision) || input.revision < 0) return json({ error: 'Reload settings and try again.' }, 400);
      const settings = validateSettings(input.settings);
      const saved = await store.save(settings, input.revision);
      return json(saved);
    }
    return json({ error: 'Admin action not found.' }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Could not save settings. Try again.' }, /another page/.test(error?.message) ? 409 : 400);
  }
}
