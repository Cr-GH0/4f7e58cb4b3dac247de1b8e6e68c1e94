// Teacher console — one page for both teacher devices. The phone is a plain
// session list plus chat: each new session's first message triggers the
// classroom show and Mimi answers with a fixed line. The desktop (wide layout)
// additionally polls the show state and performs it in the left column while
// the report opens on the right panel. All show content is prepared beforehand
// on the server; this page only plays it.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const marked = text => esc(text).replace(/\*([^*\n]+)\*/g, '<span class="tc-mark">$1</span>');

const STORE_KEY = 'mimi.teacher.v1';
const newSessionId = () => 's' + Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');

export function mountTeacherConsole(host, { account, storage = globalThis.localStorage } = {}) {
  let sessions = { currentId: null, list: [] }, storeError = '';
  try { sessions = JSON.parse(storage.getItem(STORE_KEY) ?? 'null') ?? sessions; }
  catch { storeError = 'Could not read your sessions on this device.'; }
  if (!sessions.list.some(s => s.id === sessions.currentId)) sessions.currentId = null;
  const persist = () => { try { storage.setItem(STORE_KEY, JSON.stringify(sessions)); } catch { storeError = 'Could not save sessions on this device.'; } };
  persist();

  const state = { view: sessions.currentId ? 'chat' : 'history', chatView: 'session', error: storeError, sending: false, draft: '', pauseMs: 1200, online: true };
  const wide = matchMedia('(min-width: 1000px)');
  const show = { running: false, lastSeenVersion: 0, armed: false };
  let sendTimer = null, runToken = 0;

  const current = () => sessions.list.find(s => s.id === sessions.currentId) ?? null;
  const api = async (path, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Mimi could not complete this request.');
    return result;
  };

  // ---- audio: one armed element for ack and narration playback ----
  let player = null, warmContext = null;
  async function armAudio() {
    if (show.armed) return;
    try {
      const Context = window.AudioContext ?? window.webkitAudioContext;
      warmContext ??= new Context();
      await warmContext.resume();
      if (!player) {
        const view = new DataView(new ArrayBuffer(44 + 800));
        for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) for (let i = 0; i < 4; i++) view.setUint8(offset + i, text.charCodeAt(i));
        view.setUint32(4, 836, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        view.setUint32(40, 800, true);
        player = new Audio(URL.createObjectURL(new Blob([view.buffer], { type: 'audio/wav' })));
        player.volume = 0;
        await player.play();
      }
      show.armed = Boolean(player);
    } catch { /* Keep the arm button so the teacher can retry. */ }
    render();
  }
  // Token-aware playback: a superseded segment settles quietly without
  // touching the element the newer segment now owns, and its blob URL is
  // always released. Without a gesture the element is created on demand and
  // the timing fallback keeps the show moving.
  function playSegment(id, text, token) {
    return new Promise(resolve => {
      let settled = false, fallbackTimer = null, objectUrl = '';
      const stale = () => token !== undefined && token !== runToken;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(fallbackTimer);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        resolve();
      };
      const element = () => { try { return (player ??= new Audio()); } catch { return null; } };
      const fallback = () => {
        clearTimeout(fallbackTimer);
        fallbackTimer = setTimeout(settle, Math.max(2400, [...String(text)].length * 320));
        const audio = element();
        if (audio) { audio.onended = settle; audio.onerror = settle; }
      };
      fetch(`/api/show/audio/${id}`, { cache: 'no-store' })
        .then(response => response.ok ? response.blob() : null)
        .then(blob => {
          if (settled) return;
          if (stale()) return settle();
          if (!blob) return fallback();
          const audio = element();
          if (!audio) return fallback();
          audio.onended = settle;
          audio.onerror = fallback;
          objectUrl = URL.createObjectURL(blob);
          audio.src = objectUrl;
          audio.volume = 1;
          try { audio.play().catch(fallback); } catch { fallback(); }
        })
        .catch(fallback);
    });
  }

  // ---- show transcript (desktop left column) ----
  const showLines = [];
  let traceTexts = [], traceState = { marks: [], done: false }, reportInChat = false, showContent = null;
  const lineMarkup = line => line.role === 'teacher'
    ? `<div class="tc-line tc-teacher">${esc(line.text)}</div>`
    : `<div class="tc-line tc-mimi">${esc(line.text)}</div>`;
  function showTranscriptMarkup() {
    const trace = traceState.done
      ? `<p class="tc-trace-done">已完成 ${traceState.marks.length} 步</p>`
      : traceState.marks.map((mark, i) => `<p class="tc-trace-step ${mark === 'done' ? 'is-done' : mark === 'active' ? 'is-active' : ''}"><span class="tc-trace-dot" aria-hidden="true"></span>${esc(traceTexts[i] ?? '')}</p>`).join('');
    const card = reportInChat && showContent ? `<div class="tc-report-card">
      <p class="tc-kicker">MIMI · SPEAKING PRACTICE</p>
      <h3 class="tc-report-card-title">${esc(showContent.report.title)}</h3>
      ${showContent.report.cases.map(item => `<p class="tc-report-card-line">${marked(item.revised)}</p>`).join('')}
    </div>` : '';
    return showLines.map(lineMarkup).join('') + (traceState.marks.length || traceState.done ? `<div class="tc-trace">${trace}</div>` : '') + card;
  }
  function panelMarkup() {
    if (!showContent) return '';
    const report = showContent.report;
    return `
      <p class="tc-kicker">MIMI · SPEAKING PRACTICE</p>
      <h1 class="tc-title">${esc(report.title)}</h1>
      ${report.cases.map(item => `<div class="tc-case">
        <p class="tc-sentence">${marked(item.original)}</p>
        <p class="tc-sentence tc-revised">${marked(item.revised)}</p>
        <p class="tc-note">${esc(item.note)}</p>
      </div>`).join('')}
      <h2 class="tc-method-title">${esc(report.method.title)}</h2>
      <ol class="tc-method">${report.method.steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol>`;
  }
  async function runShow(snapshot) {
    const token = ++runToken;
    let content = null;
    try { content = await api('/api/show/content'); } catch { content = null; }
    if (token !== runToken) return;
    if (!content) { state.error = '无法加载课堂演出内容，请检查服务器上的 show-content.json。'; render(); return; }
    // The version is only consumed once the content has arrived, so a network
    // hiccup here simply retries on the next poll.
    show.lastSeenVersion = snapshot.version;
    showContent = content;
    showLines.length = 0;
    traceTexts = content.traceSteps;
    traceState = { marks: [], done: false };
    reportInChat = false;
    state.chatView = 'show';
    show.running = true;
    const resume = Math.max(0, Math.min(snapshot.lastSegment ?? 0, content.narration.length));
    if (resume > 0) {
      showLines.push({ role: 'teacher', text: snapshot.triggerText }, { role: 'mimi', text: content.ack });
      traceState = { marks: content.traceSteps.map(() => 'done'), done: true };
      reportInChat = true;
      render();
      await playNarration(snapshot, resume, token);
      return;
    }
    showLines.push({ role: 'teacher', text: snapshot.triggerText });
    render();
    await delay(600); if (token !== runToken) return;
    showLines.push({ role: 'mimi', text: content.ack });
    render();
    if (snapshot.audioReady) await playSegment('ack', content.ack, token);
    if (token !== runToken) return;
    traceState = { marks: content.traceSteps.map(() => 'pending'), done: false };
    render();
    for (let i = 0; i < traceState.marks.length; i++) {
      traceState.marks[i] = 'active';
      render();
      await delay(1400);
      if (token !== runToken) return;
      traceState.marks[i] = 'done';
      render();
    }
    traceState.done = true;
    render();
    await delay(400); if (token !== runToken) return;
    reportInChat = true;
    render();
    await delay(500); if (token !== runToken) return;
    await playNarration(snapshot, 0, token);
  }
  async function playNarration(snapshot, start, token) {
    for (let i = start; i < showContent.narration.length; i++) {
      const segment = showContent.narration[i];
      void api('/api/show/progress', { version: snapshot.version, segment: i }).catch(() => {});
      await playSegment(segment.id, segment.text, token);
      if (token !== runToken) return;
    }
    void api('/api/show/progress', { version: snapshot.version, segment: showContent.narration.length }).catch(() => {});
    show.running = false;
    render();
  }

  // ---- desktop polling doubles as the heartbeat ----
  async function pollOnce() {
    try {
      const snapshot = await api('/api/show/state');
      const wasOnline = state.online;
      state.online = true;
      if (snapshot.version > show.lastSeenVersion) {
        if (snapshot.active) void runShow(snapshot);
      } else if (!wasOnline) render();
    } catch { if (state.online) { state.online = false; render(); } }
  }
  async function poll() {
    for (;;) {
      await delay(700);
      if (!wide.matches) continue;
      await pollOnce();
    }
  }

  // ---- sessions and sending ----
  function newSession() {
    const session = { id: newSessionId(), title: '', createdAt: new Date().toISOString(), lines: [] };
    sessions.list.unshift(session);
    sessions.currentId = session.id;
    state.chatView = 'session';
    state.view = 'chat';
    persist();
  }
  async function send(text) {
    const value = String(text ?? '').trim();
    if (!value) return;
    if (!current() || state.sending) { state.draft = value; render(); return; }
    state.sending = true; state.error = ''; state.draft = '';
    const session = current();
    session.lines.push({ role: 'teacher', text: value });
    if (!session.title) session.title = value.slice(0, 16);
    render();
    try {
      const result = await api('/api/show/say', { conversationId: session.id, text: value });
      session.lines.push({ role: 'mimi', text: result.reply });
      persist();
    } catch (error) { state.error = error.message; }
    state.sending = false;
    render();
  }

  // ---- rendering ----
  function sessionList() {
    return sessions.list.map(s => `<button type="button" class="tc-session ${s.id === sessions.currentId ? 'is-current' : ''}" data-tc-session="${esc(s.id)}">
      <strong>${esc(s.title || '新会话')}</strong><small>${s.lines.length} 条 · ${esc(new Date(s.createdAt).toLocaleString('zh-CN'))}</small>
    </button>`).join('');
  }
  function chatColumn() {
    const session = current();
    const showMode = wide.matches && showLines.length && state.chatView === 'show';
    if (showMode) return `<div class="tc-show" data-tc-show>${showTranscriptMarkup()}</div>`;
    if (!session) return `<div class="tc-empty"><p>新建一个会话，对 Mimi 说出课堂总结的请求。</p></div>`;
    return `<div class="tc-messages">${session.lines.map(lineMarkup).join('')}</div>`;
  }
  function render() {
    const isWide = wide.matches;
    const history = state.view === 'history';
    const active = document.activeElement;
    const composerWasFocused = Boolean(active && host.contains(active) && active.dataset && active.dataset.tcInput !== undefined);
    const caret = composerWasFocused ? active.selectionStart : null;
    const panelBefore = host.querySelector('[data-tc-panel]');
    const panelScroll = panelBefore ? panelBefore.scrollTop : 0;
    host.innerHTML = `<main class="tc-app ${isWide ? 'is-wide' : ''}">
      <header class="tc-header">
        <span class="wordmark">Mimi</span>
        ${isWide ? `<span class="tc-status ${state.online ? '' : 'is-offline'}">${state.online ? '课堂大屏在线' : '连接中断…'}</span>` : ''}
        <span class="tc-actions">
          <button type="button" data-tc="history">${history ? '返回' : '会话记录'}</button>
          <button type="button" data-tc="new">新会话</button>
          <button type="button" data-tc="logout">退出</button>
        </span>
      </header>
      <div class="tc-body">
        ${history ? `<section class="tc-sessions">${sessionList() || '<p class="tc-empty">还没有会话。</p>'}</section>` : `
        <section class="tc-chat">
          <div class="tc-scroll" data-tc-scroll>${chatColumn()}</div>
          ${show.armed || !isWide ? '' : `<button type="button" class="tc-arm" data-tc="arm">开启声音 · Enable sound</button>`}
          <footer class="tc-composer">
            <textarea data-tc-input rows="1" placeholder="对 Mimi 说……（停顿后自动发送）">${esc(state.draft)}</textarea>
            <p class="tc-hint">${state.sending ? '正在发送…' : '语音输入法说完整句，停一下即发送；电脑 Enter 立即发送'}</p>
          </footer>
        </section>`}
        ${isWide ? `<aside class="tc-panel" data-tc-panel ${showContent && reportInChat && state.chatView === 'show' ? '' : 'hidden'}>${panelMarkup()}</aside>` : ''}
      </div>
      ${state.error ? `<p class="tc-error" role="alert">${esc(state.error)}</p>` : ''}
    </main>`;
    const panel = host.querySelector('[data-tc-panel]');
    if (panel && panelScroll) panel.scrollTop = panelScroll;
    if (composerWasFocused) {
      const box = host.querySelector('[data-tc-input]');
      if (box) {
        box.focus({ preventScroll: true });
        if (caret !== null) { try { box.setSelectionRange(caret, caret); } catch { /* detached */ } }
      }
    }
    const scroller = host.querySelector('[data-tc-scroll]');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    const input = host.querySelector('[data-tc-input]');
    if (input) {
      input.addEventListener('input', () => {
        state.draft = input.value;
        clearTimeout(sendTimer);
        if (input.value.trim()) sendTimer = setTimeout(() => {
          const value = state.draft.trim();
          if (value) void send(value);
        }, state.pauseMs);
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          clearTimeout(sendTimer);
          const value = state.draft.trim();
          if (value) void send(value);
        }
      });
    }
  }

  async function click(event) {
    const button = event.target.closest('[data-tc], [data-tc-session]');
    if (!button) return;
    if (button.dataset.tcSession) {
      sessions.currentId = button.dataset.tcSession;
      state.view = 'chat';
      state.chatView = 'session';
      persist();
      render();
      return;
    }
    const action = button.dataset.tc;
    if (action === 'new') { newSession(); render(); }
    if (action === 'history') { state.view = state.view === 'history' ? 'chat' : 'history'; render(); }
    if (action === 'arm') await armAudio();
    if (action === 'logout') { try { await api('/api/student/logout', {}); } catch { /* reload anyway */ } location.reload(); }
  }
  host.addEventListener('click', click);
  host.addEventListener('pointerdown', () => { if (wide.matches) void armAudio(); });
  // Returning to the foreground must refresh the heartbeat immediately:
  // background tabs get their timers throttled, which would otherwise read as
  // "desktop offline" right at the trigger moment.
  document.addEventListener('visibilitychange', onVisibility);
  wide.addEventListener?.('change', () => render());
  function onVisibility() { if (!document.hidden && wide.matches) void pollOnce(); }
  void fetch('/api/config', { cache: 'no-store' }).then(r => r.json()).then(c => { state.pauseMs = Math.min(5000, Math.max(300, Number(c.autoSendPauseMs) || 1200)); }).catch(() => {});
  render();
  void poll();
  return () => { runToken++; clearTimeout(sendTimer); host.removeEventListener('click', click); document.removeEventListener('visibilitychange', onVisibility); };
}
