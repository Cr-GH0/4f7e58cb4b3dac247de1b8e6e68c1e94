import { readTicket, signTicket } from './admin-security.js';

const COOKIE = 'mimi_student';
const LOGIN_SECONDS = 180 * 24 * 60 * 60;
export const TEACHER_NAMES = ['sunyumeng'];
// A tiny per-process throttle: the 4-digit code space is small, so slow down
// online guessing without keeping any persistent state.
const LOGIN_MAX_FAILURES = 5, LOGIN_LOCK_MS = 30_000;
let loginFailures = 0, loginLockedUntil = 0;
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const cleanCode = value => String(value ?? '').trim();
const nameOf = value => {
  const name = String(value ?? '').trim();
  if ([...name].length > 32 || /[\u0000-\u001f]/.test(name)) throw new Error('Use a name of up to 32 characters.');
  return name;
};
// Behind a reverse proxy the browser's Origin is the public https domain while the
// request URL may be rebuilt from internal Host values. Compare hosts, accepting
// every host identity the proxy chain provides; cross-site origins still fail.
// Origins on the WorkBuddy publish platform itself (*.app.workbuddy.link) are also
// accepted: publish links always live there, and cookies are host-only + SameSite,
// so a sibling app can never carry this site's credentials.
const PLATFORM_SUFFIX = '.app.workbuddy.link';
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
export const studentProfile = row => ({ id: String(row.id), accountName: row.account_code, name: row.name, role: row.role ?? (TEACHER_NAMES.includes(row.account_code) ? 'teacher' : 'student') });

export async function currentStudent(request, store, secret) {
  const cookie = (request.headers.get('Cookie') ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='));
  const ticket = await readTicket(cookie?.slice(COOKIE.length + 1), secret, 'student-login');
  if (!ticket) return null;
  return (await store.get(ticket.studentId)) ?? null;
}

export async function studentRequest(request, store, secret) {
  const url = new URL(request.url), action = url.pathname.split('/').pop();
  const cookie = value => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value ? LOGIN_SECONDS : 0}${url.protocol === 'https:' ? '; Secure' : ''}`;
  const login = async row => json({ account: studentProfile(row) }, 200, {
    'Set-Cookie': cookie(await signTicket({ purpose: 'student-login', studentId: row.id, expiresAt: Date.now() + LOGIN_SECONDS * 1000 }, secret)),
  });
  try {
    if (action === 'status' && request.method === 'GET') {
      const row = await currentStudent(request, store, secret);
      return row ? login(row) : json({ account: null });
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    if (!originAllowed(request, url)) return json({ error: 'Open Mimi directly to continue.' }, 403);
    if (action === 'logout') return json({ ok: true }, 200, { 'Set-Cookie': cookie('') });
    const input = await request.json();
    if (action === 'login') {
      const code = cleanCode(input.code);
      if (Date.now() < loginLockedUntil) return json({ error: 'Too many attempts. Try again in a moment.' }, 429);
      const teacher = TEACHER_NAMES.find(name => name.toLowerCase() === code.toLowerCase());
      if (teacher) { loginFailures = 0; return login(await store.ensureTeacher(teacher)); }
      if (!/^[1-9][0-9]{3}$/.test(code)) return json({ error: 'Enter your 4-digit account number or your teacher account.' }, 400);
      const row = await store.byCode(code);
      if (!row) {
        loginFailures += 1;
        if (loginFailures >= LOGIN_MAX_FAILURES) { loginLockedUntil = Date.now() + LOGIN_LOCK_MS; loginFailures = 0; }
        return json({ error: 'That account number was not found.' }, 401);
      }
      loginFailures = 0;
      return login(row);
    }
    if (action === 'rename') {
      const row = await currentStudent(request, store, secret);
      if (!row) return json({ error: 'Sign in to continue.' }, 401);
      return login(await store.rename(row.id, nameOf(input.name)));
    }
    if (action !== 'register') return json({ error: 'Not found.' }, 404);
    const existing = await currentStudent(request, store, secret);
    if (existing) return json({ error: 'This browser already has a registered account.' }, 409);
    const row = await store.createStudent(nameOf(input.name));
    if (!row) return json({ error: 'All 50 classroom accounts are already reserved. Please contact your teacher.' }, 409);
    return login(row);
  } catch (error) { return json({ error: error.message || 'Account setup is unavailable. Please try again.' }, 502); }
}
