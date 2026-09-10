import { signOut } from './sign-out.js';
import { ShowAudio } from './show-audio.js';
import { mountClassroomDisplay } from './classroom-display.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STORE_KEY = 'mimi.teacher.v1';
const newSessionId = () => 's' + Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');

// A desktop remains a presentation surface even in a narrow preview window.
// Touch-only phones retain their existing message composer and history.
export function mountTeacherConsole(host, { storage = globalThis.localStorage, audio = new ShowAudio() } = {}) {
  const pointer = matchMedia('(hover: hover) and (pointer: fine)');
  const wide = matchMedia('(min-width: 1000px)');
  let cleanup, desktop;
  function mount() {
    const next = pointer.matches || wide.matches;
    if (cleanup && next === desktop) return;
    cleanup?.();
    desktop = next;
    cleanup = desktop ? mountClassroomDisplay(host, { storage, audio }) : mountTeacherPhone(host, { storage });
  }
  pointer.addEventListener?.('change', mount);
  wide.addEventListener?.('change', mount);
  mount();
  return () => { cleanup?.(); audio.dispose(); pointer.removeEventListener?.('change', mount); wide.removeEventListener?.('change', mount); };
}

function mountTeacherPhone(host, { storage }) {
  let sessions = { currentId: null, list: [] }, error = '';
  try { sessions = JSON.parse(storage.getItem(STORE_KEY) ?? 'null') ?? sessions; }
  catch { error = 'Could not read your sessions on this device.'; }
  if (!sessions.list.some(s => s.id === sessions.currentId)) sessions.currentId = null;
  let signingOut = false, history = false, sending = false, composing = false, pending = null, draft = '', pauseMs = 1200, timer, disposed = false;
  const current = () => sessions.list.find(s => s.id === sessions.currentId) ?? null;
  const persist = () => { try { storage.setItem(STORE_KEY, JSON.stringify(sessions)); } catch { error = 'Could not save sessions on this device.'; } };
  const api = async (path, body) => {
    const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000), headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Mimi could not complete this request.');
    return data;
  };
  function newSession() {
    const session = { id: newSessionId(), title: '', createdAt: new Date().toISOString(), lines: [] };
    sessions.list.unshift(session);
    sessions.currentId = session.id;
    history = false;
    persist();
  }
  async function send(text, requestId = null) {
    const value = String(text ?? '').trim();
    if (!value || disposed || sending || signingOut || composing) return;
    clearTimeout(timer);
    if (!current()) newSession();
    sending = true; error = ''; draft = '';
    const session = current();
    if (!requestId) session.lines.push({ role: 'teacher', text: value });
    pending = { text: value, requestId: requestId ?? newSessionId() };
    if (!session.title) session.title = value.slice(0, 16);
    persist(); render();
    try {
      const result = await api('/api/show/say', { conversationId: session.id, requestId: pending.requestId, text: value });
      session.lines.push({ role: 'mimi', text: result.reply });
      pending = null;
      persist();
    } catch (e) { error = e.message; }
    sending = false; render();
  }
  function render() {
    if (disposed) return;
    const active = document.activeElement;
    const focused = Boolean(active && host.contains(active) && active.dataset?.tcInput !== undefined);
    const caret = focused ? active.selectionStart : null;
    const session = current();
    host.innerHTML = `<main class="tc-app"><header class="tc-header"><span class="wordmark">Mimi</span><span class="tc-actions"><button type="button" data-tc="history">${history ? 'Back' : 'History'}</button><button type="button" data-tc="new">New chat</button><button type="button" data-tc="logout" ${signingOut ? 'disabled' : ''}>Sign out</button></span></header><div class="tc-body">${history
      ? `<section class="tc-sessions">${sessions.list.map(s => `<button type="button" class="tc-session ${s.id === sessions.currentId ? 'is-current' : ''}" data-tc-session="${esc(s.id)}"><strong>${esc(s.title || 'New chat')}</strong><small>${esc(new Date(s.createdAt).toLocaleString('en-GB'))}</small></button>`).join('') || '<p class="tc-empty">No conversations yet.</p>'}</section>`
      : `<section class="tc-chat ${!session ? 'is-empty' : ''}" aria-label="Conversation"><div class="tc-scroll" data-tc-scroll>${session ? session.lines.map(line => `<div class="tc-line ${line.role === 'teacher' ? 'tc-teacher' : 'tc-mimi'}">${esc(line.text)}</div>`).join('') : ''}</div><footer class="tc-composer"><textarea data-tc-input rows="1" aria-label="Message Mimi" placeholder="Message Mimi" ${sending ? 'readonly' : ''}>${esc(draft)}</textarea>${sending ? '<p class="tc-hint" role="status">Sending…</p>' : ''}</footer></section>`}</div>${error ? `<p class="tc-error" role="alert">${esc(error)}${pending ? ' <button type="button" data-tc="retry">Try again</button>' : ''}</p>` : ''}</main>`;
    const input = host.querySelector('[data-tc-input]');
    if (focused && input) { input.focus({ preventScroll: true }); if (caret !== null) input.setSelectionRange(caret, caret); }
    const scroller = host.querySelector('[data-tc-scroll]');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    const schedule = () => { clearTimeout(timer); if (!composing && !sending && draft.trim()) timer = setTimeout(() => void send(draft), pauseMs); };
    input?.addEventListener('compositionstart', () => { composing = true; clearTimeout(timer); });
    input?.addEventListener('compositionend', () => { composing = false; draft = input.value; schedule(); });
    input?.addEventListener('input', event => {
      draft = input.value; clearTimeout(timer);
      if (!event.isComposing) schedule();
    });
    input?.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) { event.preventDefault(); clearTimeout(timer); void send(draft); }
    });
  }
  async function click(event) {
    const button = event.target.closest('[data-tc], [data-tc-session]');
    if (!button || button.disabled) return;
    if (button.dataset.tc === 'logout') {
      signingOut = true; clearTimeout(timer); button.disabled = true;
      try { await signOut(); }
      catch (e) { signingOut = false; error = e.message; render(); }
      return;
    }
    if (sending || signingOut) return;
    if (button.dataset.tc === 'retry' && pending) { void send(pending.text, pending.requestId); return; }
    if (button.dataset.tcSession) { sessions.currentId = button.dataset.tcSession; history = false; persist(); }
    if (button.dataset.tc === 'new') { clearTimeout(timer); draft = ''; pending = null; composing = false; error = ''; newSession(); }
    if (button.dataset.tc === 'history') history = !history;
    render();
  }
  host.addEventListener('click', click);
  void api('/api/config').then(c => { pauseMs = Math.min(5000, Math.max(300, Number(c.autoSendPauseMs) || 1200)); }).catch(() => {});
  render();
  return () => { disposed = true; clearTimeout(timer); host.removeEventListener('click', click); };
}
