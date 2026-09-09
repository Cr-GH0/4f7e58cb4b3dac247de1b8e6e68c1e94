import { mountCoach } from './coach-view.js';
import { mountTeacherConsole } from './teacher-console.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const STUDENT_INITIAL_MARKUP = '<main class="student-entry"><span class="wordmark">Mimi</span><section><h1>Opening your account</h1><p role="status">Connecting to Mimi…</p></section></main>';
export const accountStorage = (storage, id) => ({
  getItem: key => storage.getItem(`mimi.account.${id}.${key}`),
  setItem: (key, value) => storage.setItem(`mimi.account.${id}.${key}`, value),
});

/** Entry has no RTC room, conversation, ASR task, or model response. */
export function mountStudentEntry(host, options) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  let rtcPromise;
  const loadRtc = () => { rtcPromise ??= options.loadRtc().catch(e => { rtcPromise = null; throw e; }); return rtcPromise; };
  let account = null, cleanup = null, destroyed = false;
  let phase = 'loading', error = '', name = '', code = '', copied = false;
  const api = async (action, body) => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 35000);
    try {
      const response = await fetchFn('/api/student/' + action, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Mimi could not complete this request.');
      return result;
    } finally { clearTimeout(timer); }
  };
  function enter() {
    if (destroyed || !account) return;
    phase = 'conversation';
    if (account.role === 'teacher') {
      cleanup = mountTeacherConsole(host, { account, storage: accountStorage(options.storage ?? globalThis.localStorage, account.id),
        onRename: async value => { account = (await api('rename', { name: value })).account; return account; } });
      return;
    }
    void loadRtc().catch(() => {});
    cleanup = mountCoach(host, { ...options, loadRtc, account, storage: accountStorage(options.storage ?? globalThis.localStorage, account.id),
      onAccount: () => { cleanup?.(); cleanup = null; phase = 'account'; error = ''; copied = false; render(); },
      onRename: async value => { account = (await api('rename', { name: value })).account; return account; },
    });
  }
  function render() {
    if (destroyed || phase === 'conversation') return;
    const busy = ['loading', 'creating', 'signing-in'].includes(phase);
    const teacher = account?.role === 'teacher';
    let content;
    if (phase === 'loading') content = '<h1>Opening your account</h1><p role="status">Connecting to Mimi…</p>';
    else if (account) content = `<h1>Your Mimi account</h1>${account.name ? `<p>${esc(account.name)}</p>` : ''}<label for="account-number">${teacher ? 'Your teacher account' : 'Your account number'}</label><input id="account-number" class="account-number" readonly value="${esc(account.accountName)}"><button data-entry="copy-account">${teacher ? 'Copy account name' : 'Copy account number'}</button>${copied ? `<p role="status">${teacher ? 'Account name copied.' : 'Account number copied.'}</p>` : ''}${teacher ? '' : '<p>Keep these four digits. Use them to sign in on another phone or browser.</p>'}<button class="primary" data-entry="enter">Go to Mimi</button><button data-entry="logout">Sign out</button>`;
    else content = `<h1>Create your account</h1><p>You’ll get your own 4-digit account number and stay signed in.</p><label for="student-name">Your name (optional)</label><input id="student-name" maxlength="32" autocomplete="given-name" value="${esc(name)}"><button class="primary" data-entry="create" ${busy ? 'disabled' : ''}>${phase === 'creating' ? 'Creating your account…' : 'Create my account'}</button><details ${phase === 'signing-in' || code ? 'open' : ''}><summary>I already have an account</summary><form data-entry-form="login"><label for="login-account">4-digit number or teacher account</label><input id="login-account" name="code" placeholder="4-digit number or teacher account" autocomplete="username" spellcheck="false" value="${esc(code)}" required><button type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Signing in…' : 'Sign in'}</button></form></details>`;
    host.innerHTML = `<main class="student-entry"><a class="wordmark" href="/">Mimi</a><section aria-label="Mimi account">${content}${error ? `<p class="error-notice" role="alert">${esc(error)}</p><button data-entry="refresh">Try again</button>` : ''}</section></main>`;
  }
  async function click(event) {
    const button = event.target.closest('[data-entry]'); if (!button || button.disabled) return;
    const action = button.dataset.entry;
    try {
      if (action === 'create') {
        phase = 'creating'; error = ''; render();
        account = (await api('register', { name })).account; phase = 'account';
      }
      if (action === 'enter') { enter(); return; }
      if (action === 'logout') { await api('logout', {}); account = null; copied = false; code = ''; name = ''; phase = 'setup'; }
      if (action === 'copy-account') {
        const field = host.querySelector('#account-number');
        field?.focus(); field?.select();
        try { await navigator.clipboard.writeText(account.accountName); copied = true; }
        catch { return; }
      }
      if (action === 'refresh') { error = ''; if (!account) { phase = 'loading'; render(); const result = await api('status'); account = result.account; if (account) { enter(); return; } phase = 'setup'; } }
    } catch (e) { error = e.message; if (phase === 'creating') phase = 'setup'; if (phase === 'loading') phase = 'setup'; }
    render();
  }
  async function submit(event) {
    if (!event.target.matches('[data-entry-form="login"]')) return;
    event.preventDefault(); if (phase === 'signing-in') return;
    code = new FormData(event.target).get('code'); phase = 'signing-in'; error = ''; render();
    try { account = (await api('login', { code })).account; enter(); }
    catch (e) { error = e.message; phase = 'setup'; render(); }
  }
  const input = event => { if (event.target.id === 'student-name') name = event.target.value; if (event.target.id === 'login-account') code = event.target.value; };
  host.addEventListener('click', click); host.addEventListener('submit', submit); host.addEventListener('input', input);
  render();
  void api('status').then(result => { if (destroyed) return; account = result.account; if (account) enter(); else { phase = 'setup'; render(); } }).catch(e => { error = e.message; phase = 'setup'; render(); });
  return () => { destroyed = true; cleanup?.(); host.removeEventListener('click', click); host.removeEventListener('submit', submit); host.removeEventListener('input', input); };
}
