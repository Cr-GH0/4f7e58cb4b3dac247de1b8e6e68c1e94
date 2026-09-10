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
  let viewportFrame = null;
  let resetting = false, resetRequest = null, resetNotice = '', resetEpoch = 0, sendGeneration = 0;
  const current = () => sessions.list.find(s => s.id === sessions.currentId) ?? null;
  const persist = () => { try { storage.setItem(STORE_KEY, JSON.stringify(sessions)); } catch { error = 'Could not save sessions on this device.'; } };
  const api = async (path, body) => {
    const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000), headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Mimi could not complete this request.');
    return data;
  };
  const initialState = api('/api/show/state').then(state => { if (sendGeneration === 0) resetEpoch = state.resetEpoch ?? 0; });
  void initialState.catch(() => {});
  function newSession() {
    const session = { id: newSessionId(), title: '', createdAt: new Date().toISOString(), lines: [] };
    sessions.list.unshift(session);
    sessions.currentId = session.id;
    history = false;
    persist();
  }
  async function send(text, requestId = null) {
    const value = String(text ?? '').trim();
    if (!value || disposed || sending || signingOut || resetting || resetRequest || composing) return;
    clearTimeout(timer);
    if (!current()) newSession();
    const generation = sendGeneration;
    sending = true; error = ''; resetNotice = ''; draft = '';
    const session = current();
    if (!requestId) session.lines.push({ role: 'teacher', text: value });
    pending = { text: value, requestId: requestId ?? newSessionId() };
    if (!session.title) session.title = value.slice(0, 16);
    persist(); render();
    try {
      await initialState.catch(async () => { const state = await api('/api/show/state'); if (generation === sendGeneration) resetEpoch = state.resetEpoch ?? 0; });
      if (generation !== sendGeneration || disposed) return;
      const result = await api('/api/show/say', { conversationId: session.id, requestId: pending.requestId, text: value, resetEpoch });
      if (generation !== sendGeneration || disposed) return;
      session.lines.push({ role: 'mimi', text: result.reply });
      pending = null;
      persist();
    } catch (e) { if (generation !== sendGeneration || disposed) return; error = e.message; }
    sending = false; render();
  }
  async function forceReset() {
    if (resetting || signingOut) return;
    resetting = true; resetRequest ??= newSessionId(); sendGeneration++;
    clearTimeout(timer); sending = false; pending = null; draft = ''; composing = false; error = ''; resetNotice = '正在重置…'; render();
    try {
      const result = await api('/api/show/reset', { requestId: resetRequest });
      if (disposed) return;
      resetEpoch = result.resetEpoch; resetRequest = null;
      resetNotice = '已重置'; history = false;
    } catch { resetNotice = '重置失败，请再次点击重试。'; }
    finally { resetting = false; render(); }
  }
  function updateViewport() {
    const viewport = window.visualViewport;
    const unzoomed = viewport && Math.abs(viewport.scale - 1) < .01;
    const available = unzoomed ? Math.min(innerHeight, viewport.height) : innerHeight;
    const scroller = host.querySelector('[data-tc-scroll]');
    const atBottom = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 70;
    host.dataset.teacherViewport = '';
    host.dataset.compactViewport = String(available < 520);
    host.style.setProperty('--app-height', `${available}px`);
    host.style.setProperty('--app-offset-top', `${unzoomed ? viewport.offsetTop : 0}px`);
    const input = host.querySelector('[data-tc-input]');
    if (input) {
      const top = input.scrollTop;
      const caretAtEnd = document.activeElement === input && input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
      input.style.height = '0px';
      input.style.height = `${input.scrollHeight}px`;
      input.style.overflowY = input.scrollHeight > input.clientHeight ? 'auto' : 'hidden';
      input.scrollTop = caretAtEnd ? input.scrollHeight : top;
    }
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  }
  function scheduleViewport() {
    if (viewportFrame !== null || !window.requestAnimationFrame) return;
    viewportFrame = window.requestAnimationFrame(() => { viewportFrame = null; if (!disposed) updateViewport(); });
  }
  function render() {
    if (disposed) return;
    const active = document.activeElement;
    const focused = Boolean(active && host.contains(active) && active.dataset?.tcInput !== undefined);
    const caret = focused ? active.selectionStart : null;
    const session = current();
    host.innerHTML = `<main class="tc-app"><header class="tc-header"><span class="wordmark">Mimi</span><span class="tc-actions"><button type="button" data-tc="history">${history ? 'Back' : 'History'}</button><button type="button" data-tc="new">New chat</button><button type="button" data-tc="logout" ${signingOut ? 'disabled' : ''}>Sign out</button></span></header><div class="tc-reset"><button type="button" data-tc="reset" ${resetting || signingOut ? 'disabled' : ''}>强制重置大屏</button><span role="status">${esc(resetNotice)}</span></div><div class="tc-body">${history
      ? `<section class="tc-sessions">${sessions.list.map(s => `<button type="button" class="tc-session ${s.id === sessions.currentId ? 'is-current' : ''}" data-tc-session="${esc(s.id)}"><strong>${esc(s.title || 'New chat')}</strong><small>${esc(new Date(s.createdAt).toLocaleString('en-GB'))}</small></button>`).join('') || '<p class="tc-empty">No conversations yet.</p>'}</section>`
      : `<section class="tc-chat ${!session ? 'is-empty' : ''}" aria-label="Conversation"><div class="tc-scroll" data-tc-scroll>${session ? session.lines.map(line => `<div class="tc-line ${line.role === 'teacher' ? 'tc-teacher' : 'tc-mimi'}">${esc(line.text)}</div>`).join('') : ''}</div><footer class="tc-composer"><textarea data-tc-input rows="1" aria-label="Message Mimi" placeholder="Message Mimi" ${sending || resetting || resetRequest ? 'readonly' : ''}>${esc(draft)}</textarea>${sending ? '<p class="tc-hint" role="status">Sending…</p>' : ''}</footer></section>`}</div>${error ? `<p class="tc-error" role="alert">${esc(error)}${pending ? ' <button type="button" data-tc="retry">Try again</button>' : ''}</p>` : ''}</main>`;
    const input = host.querySelector('[data-tc-input]');
    if (focused && input) { input.focus({ preventScroll: true }); if (caret !== null) input.setSelectionRange(caret, caret); }
    const scroller = host.querySelector('[data-tc-scroll]');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    const schedule = () => { clearTimeout(timer); if (!composing && !sending && draft.trim()) timer = setTimeout(() => void send(draft), pauseMs); };
    input?.addEventListener('compositionstart', () => { composing = true; clearTimeout(timer); });
    input?.addEventListener('compositionend', () => { composing = false; draft = input.value; schedule(); });
    input?.addEventListener('input', event => {
      draft = input.value; clearTimeout(timer); scheduleViewport();
      if (!event.isComposing) schedule();
    });
    scheduleViewport();
    input?.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) { event.preventDefault(); clearTimeout(timer); void send(draft); }
    });
  }
  async function click(event) {
    const button = event.target.closest('[data-tc], [data-tc-session]');
    if (!button || button.disabled) return;
    if (button.dataset.tc === 'reset') { void forceReset(); return; }
    if (button.dataset.tc === 'logout') {
      signingOut = true; clearTimeout(timer); button.disabled = true;
      try { await signOut(); }
      catch (e) { signingOut = false; error = e.message; render(); }
      return;
    }
    if (sending || signingOut || resetting || resetRequest) return;
    if (button.dataset.tc === 'retry' && pending) { void send(pending.text, pending.requestId); return; }
    if (button.dataset.tcSession) { sessions.currentId = button.dataset.tcSession; history = false; persist(); }
    if (button.dataset.tc === 'new') { clearTimeout(timer); draft = ''; pending = null; composing = false; error = ''; newSession(); }
    if (button.dataset.tc === 'history') history = !history;
    render();
  }
  host.addEventListener('focusin', scheduleViewport);
  host.addEventListener('focusout', scheduleViewport);
  window.addEventListener?.('resize', scheduleViewport);
  window.visualViewport?.addEventListener('resize', scheduleViewport);
  window.visualViewport?.addEventListener('scroll', scheduleViewport);
  host.addEventListener('click', click);
  void api('/api/config').then(c => { pauseMs = Math.min(5000, Math.max(300, Number(c.autoSendPauseMs) || 1200)); }).catch(() => {});
  render();
  return () => {
    disposed = true; clearTimeout(timer); host.removeEventListener('click', click);
    host.removeEventListener('focusin', scheduleViewport); host.removeEventListener('focusout', scheduleViewport);
    window.removeEventListener?.('resize', scheduleViewport);
    window.visualViewport?.removeEventListener('resize', scheduleViewport); window.visualViewport?.removeEventListener('scroll', scheduleViewport);
    if (viewportFrame !== null) window.cancelAnimationFrame(viewportFrame);
    if (host.dataset) { delete host.dataset.teacherViewport; delete host.dataset.compactViewport; }
    host.style?.removeProperty('--app-height'); host.style?.removeProperty('--app-offset-top');
  };
}
