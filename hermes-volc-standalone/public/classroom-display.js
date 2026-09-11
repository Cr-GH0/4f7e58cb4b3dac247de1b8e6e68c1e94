import { showPosition, showOffset } from './show-timing.js';
import { focusReport } from './report-focus.js';
import { signOut } from './sign-out.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHECKPOINT_KEY = 'mimi.show.checkpoint.v2';

// Keep the avatar mounted throughout: acknowledgement, work, report and return.
export function mountClassroomDisplay(host, { storage, audio }) {
  let initialized = false, initializing = false, disposed = false, running = false, seen = 0, token = 0, preparedVersion = null;
  const desktopId = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join('');
  let entered = audio.armed, preparingAssets = false, readyVersion = null, pendingDismiss = null, polling = false;
  let preparationToken = 0, preparationJob = Promise.resolve();
  let gateMessage = '进入课堂后，Mimi 会准备好声音和报告。';
  let snapshot = null, point = null, content = null, retryAt = 0, frameLoad = null, renderedVersion = null;
  let phase = 'idle', reportVisible = false, error = '', section = '', traceIndex = 0, traceDone = 0, preloadReport = false, completed = false, dismissing = false;
  const api = async (path, body) => {
    if (path === '/api/show/state') path += '?desktopId=' + desktopId;
    if (body) body = { ...body, desktopId };
    const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000), headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error ?? 'Mimi could not complete this request.'); error.lostDesktop = data.lostDesktop; error.staleReport = response.status === 409 && !data.lostDesktop; throw error; }
    return data;
  };
  function render() {
    if (disposed) return;
    let stage = host.querySelector('[data-mimi-stage]');
    if (!stage) {
      host.innerHTML = `<main class="mimi-stage" data-mimi-stage data-phase="idle" aria-label="Mimi classroom display"><details class="mimi-stage__controls" data-mimi-controls><summary class="mimi-stage__hamburger" aria-label="Classroom controls"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></summary><div class="mimi-stage__panel"><a class="mimi-stage__settings" data-mimi-settings href="/show-editor.html" hidden>后台</a><button type="button" class="mimi-stage__logout" data-mimi-logout>退出登录</button><p class="mimi-stage__logout-error" data-mimi-signout-error role="alert" hidden></p><section class="mimi-entry" data-mimi-entry><p data-mimi-entry-text role="status"></p><button type="button" data-mimi-enter>进入课堂</button></section></div></details><section class="mimi-stage__report" data-mimi-report hidden aria-label="Practice report"></section><div class="mimi-presence" data-mimi-presence role="group" aria-label="Mimi"><div class="mimi-presence__orbit" aria-hidden="true"></div><div class="mimi-presence__breath"><div class="mimi-presence__portrait"><img src="/mimi.png" width="1254" height="1254" alt="" draggable="false" fetchpriority="high"></div></div><div class="mimi-presence__signal" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><p class="mimi-presence__standby" data-mimi-standby>Mimi is standing by</p><button type="button" class="mimi-presence__return" data-mimi-return aria-label="Return to standby" title="Return to standby" hidden></button></div><section class="mimi-work" data-mimi-work hidden aria-label="Mimi is working"><ol data-mimi-steps></ol><p class="mimi-work__note" data-mimi-note role="status"></p></section><div class="mimi-stage__error" data-mimi-error hidden><p data-mimi-error-text role="status"></p><button type="button" data-mimi-retry>Try again</button><button type="button" data-mimi-dismiss>Return to standby</button></div></main>`;
      stage = host.querySelector('[data-mimi-stage]');
    }
    if (!stage) return;
    const leavingStandby = stage.dataset.phase === 'idle' && !stage.classList.contains('has-report') && (phase !== 'idle' || reportVisible);
    stage.classList.toggle('has-report', reportVisible);
    stage.dataset.phase = phase;
    stage.querySelector('[data-mimi-standby]').hidden = phase !== 'idle' || reportVisible;
    if (leavingStandby) stage.querySelector('[data-mimi-controls]').open = false;
    const gate = stage.querySelector('[data-mimi-entry]');
    if (gate) {
      gate.hidden = !gateMessage;
      stage.querySelector('[data-mimi-entry-text]').textContent = gateMessage;
      const enterButton = stage.querySelector('[data-mimi-enter]');
      enterButton.hidden = entered && (initializing || preparingAssets);
      enterButton.textContent = entered ? '重新准备' : '进入课堂';
    }
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
    focusReport(doc, content?.narration.find(part => part.id === section));
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
    token++; preparationToken++; preparingAssets = false; running = false; audio.stop(); level(0);
    snapshot = state; seen = Math.max(seen, state.version); point = null;
    completed = false; reportVisible = false; preloadReport = false; traceDone = 0; phase = 'idle'; error = ''; section = ''; content = null;
    try { storage.setItem(CHECKPOINT_KEY, 'null'); } catch {}
    render();
  }
  async function dismiss() {
    if (!snapshot?.version || dismissing) return;
    const version = snapshot.version;
    pendingDismiss = version;
    resetView({ ...snapshot, active: false, dismissed: true });
    // The UI returns immediately, even offline. Polling retries the write and
    // ignores that old performance until the server acknowledges dismissal.
    void pollOnce();
  }
  async function prepareClassroom(state) {
    if (preparingAssets || disposed) return;
    preparingAssets = true; gateMessage = '正在准备课堂…'; render();
    const version = state.version, prepToken = ++preparationToken;
    const alive = () => !disposed && entered && !snapshot?.dismissed && snapshot?.version === version && preparationToken === prepToken;
    try {
      const deadline = Date.now() + 90000;
      let next;
      do {
        next = await api('/api/show/content?version=' + version);
        if (!alive()) return;
        if (next.narrationStatus === 'error') throw new Error(next.narrationError);
        if (Date.now() > deadline) throw new Error('准备时间较长，请重新准备。');
        if (!next.audioReady || !next.narration.length) await delay(700);
      } while (!next.audioReady || !next.narration.length);
      content = next; preloadReport = true; render();
      preparationJob = preparationJob.catch(() => {}).then(() => { if (alive()) return audio.prepareShow(next); });
      await preparationJob;
      if (!alive()) return;
      if (frameLoad) await Promise.race([frameLoad, delay(15000).then(() => { throw new Error('报告未能打开。'); })]);
      if (!alive()) return;
      if (!audio.armed) throw new Error('请点击进入课堂以启用声音。');
      preparedVersion = version; readyVersion = version; gateMessage = ''; render();
    } catch (failure) {
      if (alive()) { gateMessage = failure.message || '课堂准备未完成，请重试。'; }
    } finally { if (preparationToken === prepToken) { preparingAssets = false; render(); } }
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
      if (preparedVersion !== state.version) content = await api('/api/show/content?version=' + state.version);
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
        const part = showPosition(seconds, audio.timeline);
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
      await audio.play('show', showOffset(start, audio.timeline), seconds => {
        if (!alive()) return;
        const part = showPosition(seconds, audio.timeline);
        if (part.phase !== 'done') checkpoint({ phase: part.phase, index: part.index, offset: part.offset });
      }, {
        onStart: () => displayPosition(showOffset(start, audio.timeline)),
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
    if (disposed || polling) return;
    polling = true;
    try {
      if (!entered) return;
      if (pendingDismiss !== null) {
        try { await api('/api/show/dismiss', { version: pendingDismiss }); }
        catch (failure) { if (!failure.staleReport) throw failure; }
        pendingDismiss = null; initialized = false; readyVersion = null;
      }
      if (!initialized) {
        if (initializing) return;
        initializing = true;
        try {
          const state = await api('/api/show/desktop/open', {});
          if (disposed) return;
          resetView({ ...state, active: false });
          initialized = true;
          void prepareClassroom(state);
        } finally { initializing = false; }
        return;
      }
      const state = await api('/api/show/state');
      if (disposed) return;
      if ((state.resetEpoch ?? 0) > (snapshot?.resetEpoch ?? 0)) {
        pendingDismiss = null; preparedVersion = null; readyVersion = null;
        resetView({ ...state, active: false });
        void prepareClassroom(state);
        return;
      }
      if (state.dismissed && state.version >= seen) { if (snapshot?.version !== state.version || !snapshot?.dismissed) resetView(state); return; }
      if (state.active && readyVersion === state.version && !snapshot?.active && !running && !completed) void run(state);
      else if (phase === 'paused' && !running && Date.now() >= retryAt && state.active && state.narrationStatus !== 'error') void run(state, point);
      else if (error === 'Reconnecting…') { error = ''; render(); }
      if (point && snapshot && !snapshot.dismissed) void api('/api/show/progress', { version: snapshot.version, checkpoint: point }).catch(() => {});
    } catch (failure) { if (!disposed && (!running || failure.lostDesktop)) {
      if (failure.lostDesktop) { initialized = false; entered = false; readyVersion = null; pendingDismiss = null; resetView({ ...snapshot, active: false, dismissed: true }); }
      if (!initialized) gateMessage = failure.message;
      else if (!pendingDismiss) error = 'Reconnecting…';
      render();
    } } finally { polling = false; }
  }
  async function poll() { while (!disposed) { await pollOnce(); await delay(700); } }
  const leaving = () => {
    if (disposed) return;
    if (initialized) {
      void fetch('/api/show/desktop/close', { method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ desktopId }) }).catch(() => {});
    }
    disposed = true; token++; audio.stop(); level(0);
  };
  const returned = event => { if (event.persisted) location.reload(); };
  window.addEventListener?.('pagehide', leaving);
  window.addEventListener?.('pageshow', returned);
  const interact = () => { void arm(); };
  const closeControls = event => {
    const controls = host.querySelector('[data-mimi-controls]');
    if (!controls?.open) return;
    if (event.type === 'keydown') {
      if (event.key !== 'Escape') return;
      controls.open = false;
      controls.querySelector('summary').focus();
    } else if (!controls.contains(event.target)) controls.open = false;
  };
  document.addEventListener('pointerdown', closeControls);
  document.addEventListener('keydown', closeControls);
  const click = async event => {
    if (event.target.closest('[data-mimi-enter]')) {
      await arm();
      if (!audio.armed) { gateMessage = '声音尚未启用，请再次点击进入课堂。'; render(); return; }
      entered = true; gateMessage = '正在准备课堂…'; render();
      if (initialized && snapshot) {
        try {
          const state = await api('/api/show/state');
          if (['error', 'ready'].includes(state.narrationStatus)) await api('/api/show/retry', { version: state.version });
          void prepareClassroom(state);
        } catch (failure) { gateMessage = failure.message; render(); }
      } else void pollOnce();
      return;
    }
    const logout = event.target.closest('[data-mimi-logout]');
    if (logout) {
      if (logout.disabled) return;
      logout.disabled = true;
      const notice = host.querySelector('[data-mimi-signout-error]');
      notice.hidden = true;
      try { await signOut({ beforeLeave: leaving }); }
      catch { logout.disabled = false; notice.textContent = '暂时无法退出，请重试。'; notice.hidden = false; }
      return;
    }
    if (event.target.closest('[data-mimi-return]') && completed || event.target.closest('[data-mimi-dismiss]')) void dismiss();
    if (event.target.closest('[data-mimi-retry]')) void retry();
  };
  const visible = () => { if (!document.hidden) { void arm(); void pollOnce(); } };
  host.addEventListener('pointerdown', interact); host.addEventListener('keydown', interact); host.addEventListener('click', click);
  document.addEventListener('visibilitychange', visible);
  render(); void poll();
  return () => { leaving(); document.removeEventListener('pointerdown', closeControls); document.removeEventListener('keydown', closeControls); host.removeEventListener('pointerdown', interact); host.removeEventListener('keydown', interact); host.removeEventListener('click', click); document.removeEventListener('visibilitychange', visible); window.removeEventListener?.('pagehide', leaving); window.removeEventListener?.('pageshow', returned); };
}
