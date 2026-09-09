const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHECKPOINT_KEY = 'mimi.show.checkpoint.v2';

// The desktop has one persistent report document and one persistent avatar.
// Narration stays in the playback model; it is never rendered as chat/subtitles.
export function mountClassroomDisplay(host, { storage, audio }) {
  let disposed = false, running = false, seen = 0, token = 0, preparedVersion = null;
  let snapshot = null, point = null, content = null, retryAt = 0, frameLoad = null, renderedVersion = null;
  let phase = 'idle', reportVisible = false, error = '', section = '';
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
      host.innerHTML = `<main class="mimi-stage ${reportVisible ? 'has-report' : ''}" data-mimi-stage data-phase="${phase}" aria-label="Mimi classroom display"><section class="mimi-stage__report" data-mimi-report ${reportVisible ? '' : 'hidden'} aria-label="Practice report"></section><div class="mimi-presence" data-mimi-presence role="img" aria-label="Mimi"><div class="mimi-presence__orbit" aria-hidden="true"></div><div class="mimi-presence__breath"><div class="mimi-presence__portrait"><img src="/mimi.png" width="1254" height="1254" alt="" draggable="false" fetchpriority="high"></div></div><div class="mimi-presence__signal" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div></div><p class="mimi-stage__error" data-mimi-error role="status" ${error ? '' : 'hidden'}>${esc(error)}</p></main>`;
      stage = host.querySelector('[data-mimi-stage]');
    }
    if (!stage) return;
    stage.classList.toggle('has-report', reportVisible);
    stage.dataset.phase = phase;
    const presence = stage.querySelector('[data-mimi-presence]');
    presence.setAttribute('aria-label', phase === 'speaking' ? 'Mimi is speaking' : phase === 'generating' ? 'Mimi is preparing the report' : 'Mimi');
    const notice = stage.querySelector('[data-mimi-error]');
    notice.hidden = !error; notice.textContent = error;
    const report = stage.querySelector('[data-mimi-report]');
    report.hidden = !reportVisible;
    if (reportVisible && content?.artifact) {
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
    // Only the embedded view reserves room for the corner avatar.
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
  function checkpoint(next) {
    point = next;
    const saved = { version: snapshot.version, checkpoint: next };
    try { storage.setItem(CHECKPOINT_KEY, JSON.stringify(saved)); } catch {}
    void api('/api/show/progress', saved).catch(() => {});
  }
  function restore(state) {
    const remote = state.checkpoint ?? { phase: 'ack', index: 0, offset: 0 };
    let local;
    try { local = JSON.parse(storage.getItem(CHECKPOINT_KEY) ?? 'null'); } catch {}
    if (local?.version !== state.version || local.checkpoint?.phase === 'done') return remote;
    const rank = p => ['ack', 'trace', 'narration', 'done'].indexOf(p.phase) * 1000000 + p.index * 10000 + p.offset;
    return rank(local.checkpoint) > rank(remote) ? local.checkpoint : remote;
  }
  async function arm() { try { await Promise.race([audio.arm(), delay(300)]); } catch {} }
  function level(value) {
    host.querySelector('[data-mimi-presence]')?.style.setProperty('--voice-level', value.toFixed(3));
  }
  async function run(state, resume = null) {
    if (disposed || running) return;
    running = true;
    const runToken = ++token;
    audio.stop();
    snapshot = state; seen = state.version;
    const start = resume ?? (state.active ? restore(state) : { phase: 'done', index: 0, offset: 0 });
    point = start; error = ''; retryAt = 0;
    phase = start.phase === 'done' ? 'idle' : 'generating';
    reportVisible = content?.version === state.version && ['narration', 'done'].includes(start.phase);
    render();
    try {
      content = await api('/api/show/content?version=' + state.version);
      if (disposed || token !== runToken) return;
      if (start.phase === 'done') { reportVisible = true; render(); return; }
      void arm();
      if (['ack', 'trace'].includes(start.phase)) checkpoint({ phase: 'trace', index: 0, offset: 0 });
      while (!disposed && token === runToken) {
        if (content.narration.length) { reportVisible = true; render(); }
        if (content.narrationStatus === 'error') throw new Error(content.narrationError);
        if (content.audioReady && content.narration.length) break;
        await delay(700);
        if (disposed || token !== runToken) return;
        content = await api('/api/show/content?version=' + state.version);
      }
      if (disposed || token !== runToken) return;
      if (preparedVersion !== state.version) { await audio.prepare(content); preparedVersion = state.version; }
      if (disposed || token !== runToken) return;
      reportVisible = true; render();
      await Promise.race([frameLoad ?? Promise.resolve(), delay(3000)]);
      await delay(720);
      await arm();
      if (disposed || token !== runToken) return;
      if (!audio.armed) throw new Error('Audio playback is paused.');
      const first = start.phase === 'narration' ? start.index : 0;
      for (let i = first; i < content.narration.length; i++) {
        if (disposed || token !== runToken) return;
        const part = { phase: 'narration', index: i, offset: i === first && start.phase === 'narration' ? start.offset : 0 };
        checkpoint(part); section = content.narration[i].id; focusSection();
        await audio.play(section, part.offset, offset => {
          if (!disposed && token === runToken) checkpoint({ ...part, offset });
        }, { onStart: () => { phase = 'speaking'; render(); }, onLevel: level, onEnd: () => { level(0); phase = 'idle'; render(); } });
      }
      if (disposed || token !== runToken) return;
      checkpoint({ phase: 'done', index: 0, offset: 0 });
      phase = 'idle'; section = ''; render();
    } catch (e) {
      if (disposed || token !== runToken) return;
      phase = 'paused'; error = e.message; retryAt = Date.now() + 2000; render();
    } finally { running = false; }
  }
  async function pollOnce() {
    if (disposed) return;
    try {
      const state = await api('/api/show/state');
      if (disposed) return;
      if (state.version > seen && !running) void run(state);
      else if (phase === 'paused' && !running && Date.now() >= retryAt && state.active && state.narrationStatus !== 'error') void run(state, point);
      else if (error === 'Reconnecting…') { error = ''; render(); }
      if (point && snapshot) void api('/api/show/progress', { version: snapshot.version, checkpoint: point }).catch(() => {});
    } catch { if (!running && !disposed) { error = 'Reconnecting…'; render(); } }
  }
  async function poll() { while (!disposed) { await pollOnce(); await delay(1000); } }
  const interact = () => { void arm(); };
  const visible = () => { if (!document.hidden) { void arm(); void pollOnce(); } };
  host.addEventListener('pointerdown', interact);
  host.addEventListener('keydown', interact);
  document.addEventListener('visibilitychange', visible);
  render(); void arm(); void poll();
  return () => { disposed = true; token++; audio.stop(); host.removeEventListener('pointerdown', interact); host.removeEventListener('keydown', interact); document.removeEventListener('visibilitychange', visible); };
}
