import { showPosition, showOffset } from './show-timing.js';
import { signOut } from './sign-out.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHECKPOINT_KEY = 'mimi.show.checkpoint.v2';

// Keep the avatar mounted throughout: acknowledgement, work, report and return.
export function mountClassroomDisplay(host, { storage, audio }) {
  let initialized = false, initializing = false, disposed = false, running = false, seen = 0, token = 0, preparedVersion = null;
  let snapshot = null, point = null, content = null, retryAt = 0, frameLoad = null, renderedVersion = null;
  let phase = 'idle', reportVisible = false, error = '', section = '', traceIndex = 0, traceDone = 0, preloadReport = false, completed = false, dismissing = false;
  const api = async (path, body) => {
    const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000), headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Mimi could not complete this request.');
    return data;
  };
  function render() {
    if (disposed) return;
    let stage = host.querySelector('[data-mimi-stage]');
    if (!stage) {
      host.innerHTML = `<main class="mimi-stage" data-mimi-stage data-phase="idle" aria-label="Mimi classroom display"><a class="mimi-stage__settings" data-mimi-settings href="/show-editor.html" hidden>后台</a><button type="button" class="mimi-stage__logout" data-mimi-logout>退出登录</button><p class="mimi-stage__logout-error" data-mimi-signout-error role="alert" hidden></p><section class="mimi-stage__report" data-mimi-report hidden aria-label="Practice report"></section><div class="mimi-presence" data-mimi-presence role="img" aria-label="Mimi"><div class="mimi-presence__orbit" aria-hidden="true"></div><div class="mimi-presence__breath"><div class="mimi-presence__portrait"><img src="/mimi.png" width="1254" height="1254" alt="" draggable="false" fetchpriority="high"></div></div><div class="mimi-presence__signal" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><button type="button" class="mimi-presence__return" data-mimi-return aria-label="Return to standby" title="Return to standby" hidden></button></div><section class="mimi-work" data-mimi-work hidden aria-label="Mimi is working"><ol data-mimi-steps></ol><p class="mimi-work__note" data-mimi-note role="status"></p></section><div class="mimi-stage__error" data-mimi-error hidden><p data-mimi-error-text role="status"></p><button type="button" data-mimi-retry>Try again</button><button type="button" data-mimi-dismiss>Return to standby</button></div></main>`;
      stage = host.querySelector('[data-mimi-stage]');
    }
    if (!stage) return;
    stage.classList.toggle('has-report', reportVisible);
    stage.dataset.phase = phase;
    const settingsLink = stage.querySelector('[data-mimi-settings]');
    if (settingsLink) settingsLink.hidden = phase !== 'idle' || reportVisible;
    const presence = stage.querySelector('[data-mimi-presence]');
    presence.setAttribute('aria-label', phase === 'speaking' ? 'Mimi is speaking' : phase === 'working' || phase === 'generating' ? 'Mimi is preparing the report' : 'Mimi');
    const returnButton = stage.querySelector('[data-mimi-return]');
    if (returnButton) { returnButton.hidden = !completed; returnButton.disabled = dismissing; }
    const notice = stage.querySelector('[data-mimi-error]');
    notice.hidden = !error;
    const errorText = stage.querySelector('[data-mimi-error-text]');
    if (errorText) errorText.textContent = error;
    const work = stage.querySelector('[data-mimi-work]');
    if (work) {
      work.hidden = phase !== 'working';
      if (phase === 'working' && content) {
        const steps = stage.querySelector('[data-mimi-steps]');
        const markup = content.traceSteps.slice(0, traceIndex + 1).map((text, i) => `<li class="${i < traceDone ? 'is-done' : 'is-current'}"><span class="mimi-work__mark" aria-hidden="true">${i < traceDone ? '✓' : ''}</span><span class="mimi-work__action"><span>${esc(text)}</span>${content.traceTools?.[i] ? `<code>${esc(content.traceTools[i])}()</code>` : ''}${i < traceDone && content.traceResults?.[i] ? `<span class="mimi-work__result">${esc(content.traceResults[i])}</span>` : ''}</span></li>`).join('');
        if (steps.innerHTML !== markup) steps.innerHTML = markup;
        stage.querySelector('[data-mimi-note]').textContent = content.traceNotes?.[traceIndex] ?? '';
      }
    }
    const report = stage.querySelector('[data-mimi-report]');
    report.hidden = !reportVisible;
    if ((reportVisible || preloadReport) && content?.artifact) {
      const existing = report.querySelector('iframe');
      if (!existing || existing.getAttribute('src') !== content.artifact.url || renderedVersion !== content.version) {
        renderedVersion = content.version;
        report.innerHTML = `<iframe data-mimi-report-frame src="${esc(content.artifact.url)}" title="${esc(content.artifact.title)}"></iframe>`;
        const frame = report.querySelector('iframe');
        frameLoad = new Promise(resolve => frame.addEventListener('load', () => { fitReport(frame); focusSection(); resolve(); }, { once: true }));
      }
    }
  }
  function fitReport(frame) {
    const doc = frame.contentDocument;
    if (!doc || doc.getElementById('mimi-display-insets')) return;
    const style = doc.createElement('style');
    style.id = 'mimi-display-insets';
    style.textContent = '.page{padding-right:max(42px,calc(156px - max(0px,(100vw - 1500px)/2)));padding-bottom:32px}html{scroll-behavior:auto;scroll-padding-block:20px}';
    doc.head.append(style);
  }
  function focusSection() {
    const doc = host.querySelector('[data-mimi-report-frame]')?.contentDocument;
    if (!doc) return;
    if (section === 'intro') { doc.scrollingElement.scrollTop = 0; return; }
    const target = section === 'case1' ? doc.querySelectorAll('.case')[0] : section === 'case2' ? doc.querySelectorAll('.case')[1] : section === 'method' ? doc.querySelector('.method') : null;
    target?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }
  function remember(next) {
    point = next;
    try { storage.setItem(CHECKPOINT_KEY, JSON.stringify({ version: snapshot.version, checkpoint: next })); } catch {}
  }
  function checkpoint(next) {
    remember(next);
    void api('/api/show/progress', { version: snapshot.version, checkpoint: next }).catch(() => {});
  }
  function restore(state) {
    const remote = state.checkpoint ?? { phase: 'ack', index: 0, offset: 0 };
    let local;
    try { local = JSON.parse(storage.getItem(CHECKPOINT_KEY) ?? 'null'); } catch {}
    if (local?.version !== state.version || local.checkpoint?.phase === 'done') return remote;
    const rank = p => ['ack', 'trace', 'transition', 'narration', 'closing', 'done'].indexOf(p.phase) * 1000000 + p.index * 10000 + p.offset;
    return rank(local.checkpoint) > rank(remote) ? local.checkpoint : remote;
  }
  async function arm() { try { await Promise.race([audio.arm(), delay(300)]); } catch {} }
  function level(value) { host.querySelector('[data-mimi-presence]')?.style.setProperty('--voice-level', value.toFixed(3)); }
  function resetView(state) {
    token++; running = false; audio.stop(); level(0);
    snapshot = state; seen = Math.max(seen, state.version); point = null;
    completed = false; reportVisible = false; preloadReport = false; traceDone = 0; phase = 'idle'; error = ''; section = ''; content = null;
    try { storage.setItem(CHECKPOINT_KEY, 'null'); } catch {}
    render();
  }
  async function dismiss() {
    if (!snapshot?.version || dismissing) return;
    dismissing = true; render();
    try { await api('/api/show/dismiss', { version: snapshot.version }); resetView({ ...snapshot, active: false, dismissed: true }); }
    catch { error = 'Could not return to standby. Please try again.'; render(); }
    finally { dismissing = false; render(); }
  }
  async function retry() {
    if (running || dismissing || !snapshot) return;
    error = ''; render();
    try {
      let state = await api('/api/show/state');
      if (state.dismissed) { resetView(state); return; }
      if (state.narrationStatus === 'error') { await api('/api/show/retry', { version: state.version }); state = await api('/api/show/state'); }
      void run(state, state.version === snapshot.version ? point : null);
    } catch { error = 'Could not reconnect. Please try again.'; render(); }
  }
  async function run(state, resume = null) {
    if (disposed || running || state.dismissed) return;
    running = true;
    const runToken = ++token;
    const alive = () => !disposed && token === runToken;
    audio.stop(); snapshot = state; seen = state.version;
    const start = resume ?? (state.active ? restore(state) : { phase: 'done', index: 0, offset: 0 });
    point = start; error = ''; retryAt = 0; completed = false; preloadReport = false; traceDone = 0;
    phase = 'idle'; reportVisible = Boolean(content?.version === state.version && ['transition', 'narration', 'closing', 'done'].includes(start.phase));
    render();
    try {
      content = await api('/api/show/content?version=' + state.version);
      if (!alive()) return;
      if (content.dismissed) { resetView({ ...state, dismissed: true }); return; }
      if (start.phase === 'done') { reportVisible = true; phase = 'idle'; completed = true; render(); return; }
      // Keep standby unchanged until every asset is ready. Once Mimi reacts,
      // no network request, per-segment loading or timer chain can add time.
      preloadReport = true; render();
      const deadline = Date.now() + 90000;
      while (!content.audioReady || !content.narration.length) {
        if (content.narrationStatus === 'error') { retryAt = Infinity; throw new Error(content.narrationError); }
        if (Date.now() > deadline) { retryAt = Infinity; throw new Error('The report is taking too long.'); }
        await delay(700);
        if (!alive()) return;
        content = await api('/api/show/content?version=' + state.version);
        if (content.dismissed) { resetView({ ...state, dismissed: true }); return; }
      }
      if (preparedVersion !== state.version) {
        await audio.prepareShow(content);
        preparedVersion = state.version;
      }
      if (!alive()) return;
      if (frameLoad) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The report could not be opened.')), 15000);
        frameLoad.then(() => { clearTimeout(timer); resolve(); });
      });
      await arm();
      if (!alive()) return;
      if (!audio.armed) throw new Error('Audio playback is paused.');
      let displayed = '';
      const displayPosition = seconds => {
        if (!alive()) return;
        const part = showPosition(seconds);
        if (part.phase === 'done') return; // Only the audio ended event enables return.
        const key = part.phase + ':' + part.index;
        if (key === displayed) return;
        displayed = key;
        phase = ['ack', 'narration'].includes(part.phase) ? 'speaking' : part.phase === 'trace' ? 'working' : 'generating';
        reportVisible = ['transition', 'narration', 'closing'].includes(part.phase);
        if (part.phase === 'trace') { traceIndex = part.index; traceDone = part.index; }
        if (part.phase === 'narration') section = part.audioId;
        checkpoint({ phase: part.phase, index: part.index, offset: part.offset });
        render();
        if (part.phase === 'narration') focusSection();
      };
      await audio.play('show', showOffset(start), seconds => {
        if (!alive()) return;
        const part = showPosition(seconds);
        if (part.phase !== 'done') checkpoint({ phase: part.phase, index: part.index, offset: part.offset });
      }, {
        onStart: () => displayPosition(showOffset(start)),
        onPosition: displayPosition,
        onLevel: value => { if (alive()) level(value); },
        onEnd: () => { if (alive()) level(0); },
      });
      if (!alive()) return;
      // Returning the avatar is tied to the end of the 62-second audio buffer,
      // never to a subsequent server response. Persist completion in parallel.
      const done = { phase: 'done', index: 0, offset: 0 };
      checkpoint(done); completed = true; phase = 'idle'; section = ''; render();
    } catch {
      if (!alive()) return;
      phase = 'paused'; error = 'I lost my place for a moment. Let’s try again.';
      if (retryAt !== Infinity) retryAt = Date.now() + 2500;
      render();
    } finally { if (alive()) running = false; }
  }
  async function pollOnce() {
    if (disposed) return;
    try {
      if (!initialized) {
        if (initializing) return;
        initializing = true;
        try {
          const state = await api('/api/show/desktop/open', {});
          if (disposed) return;
          resetView(state);
          initialized = true;
        } finally { initializing = false; }
        return;
      }
      const state = await api('/api/show/state');
      if (disposed) return;
      if (state.dismissed && state.version >= seen) { if (snapshot?.version !== state.version || !snapshot?.dismissed) resetView(state); return; }
      if (state.version > seen && !running) void run(state);
      else if (phase === 'paused' && !running && Date.now() >= retryAt && state.active && state.narrationStatus !== 'error') void run(state, point);
      else if (error === 'Reconnecting…') { error = ''; render(); }
      if (point && snapshot && !snapshot.dismissed) void api('/api/show/progress', { version: snapshot.version, checkpoint: point }).catch(() => {});
    } catch { if (!running && !disposed) { error = 'Reconnecting…'; render(); } }
  }
  async function poll() { while (!disposed) { await pollOnce(); await delay(700); } }
  const leaving = () => {
    if (disposed) return;
    // Best effort on a normal close; the next open also resets server state,
    // so crashes and browser session restoration cannot resurrect a report.
    if (snapshot?.version && !snapshot.dismissed) {
      void fetch('/api/show/dismiss', { method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: snapshot.version }) }).catch(() => {});
    }
    disposed = true; token++; audio.stop(); level(0);
  };
  const returned = event => { if (event.persisted) location.reload(); };
  window.addEventListener?.('pagehide', leaving);
  window.addEventListener?.('pageshow', returned);
  const interact = () => { void arm(); };
  const click = async event => {
    const logout = event.target.closest('[data-mimi-logout]');
    if (logout) {
      if (logout.disabled) return;
      logout.disabled = true;
      const notice = host.querySelector('[data-mimi-signout-error]');
      notice.hidden = true;
      try { await signOut({ beforeLeave: () => { disposed = true; token++; audio.stop(); } }); }
      catch { logout.disabled = false; notice.textContent = '暂时无法退出，请重试。'; notice.hidden = false; }
      return;
    }
    if (event.target.closest('[data-mimi-return]') && completed || event.target.closest('[data-mimi-dismiss]')) void dismiss();
    if (event.target.closest('[data-mimi-retry]')) void retry();
  };
  const visible = () => { if (!document.hidden) { void arm(); void pollOnce(); } };
  host.addEventListener('pointerdown', interact); host.addEventListener('keydown', interact); host.addEventListener('click', click);
  document.addEventListener('visibilitychange', visible);
  render(); void arm(); void audio.prepareOpening().catch(() => {}); void poll();
  return () => { disposed = true; token++; audio.stop(); host.removeEventListener('pointerdown', interact); host.removeEventListener('keydown', interact); host.removeEventListener('click', click); document.removeEventListener('visibilitychange', visible); window.removeEventListener?.('pagehide', leaving); window.removeEventListener?.('pageshow', returned); };
}
