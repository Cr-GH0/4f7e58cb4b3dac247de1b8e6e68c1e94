// Classroom show — the teacher triggers a staged performance from a phone
// session; the desktop page (same teacher account, wide layout) polls the
// state endpoint and performs: ack, tool trace, report, narration. The report
// is prepared; each performance generates its own explanation and matching
// speech. This route does not read student conversations.
import { readTicket } from './admin-security.js';
import { currentStudent, TEACHER_NAMES } from './student-api.js';
import { synthesizeSpeech } from './public/talk-api.js';
import { createNarrationGenerator } from './show-narration.js';

// Behind a reverse proxy the browser's Origin is the public https domain while
// the request URL may be rebuilt from internal Host values. Compare hosts,
// accepting every host identity the proxy chain provides.
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

export function createShowHandler({ store, students, secret, password, settings, speech, arkKey, sources, loadSources, fetcher = fetch }) {
  const narrator = loadSources ? createNarrationGenerator({ store, settings, speech, arkKey, loadSources, fetcher }) : null;
  let openingRetryAt = 0;
  const warmOpening = () => {
    if (narrator && Date.now() >= openingRetryAt) {
      openingRetryAt = Date.now() + 60000;
      void narrator.prepareOpening().catch(() => {});
    }
  };
  return async function showRequest(request) {
    const url = new URL(request.url), path = url.pathname;
    const headers = { 'Cache-Control': 'no-store' };
    const json = (data, status = 200, extra = {}) => Response.json(data, { status, headers: { ...headers, ...extra } });
    const requireTeacher = async () => {
      const row = await currentStudent(request, students, secret);
      // The D1 store has no role column; derive it the same way studentProfile does.
      return row && (row.role === 'teacher' || TEACHER_NAMES.includes(row.account_code)) ? row : null;
    };
    const requireAdmin = async () => {
      const raw = request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('hermes_admin='))?.slice('hermes_admin='.length);
      return Boolean(password) && await readTicket(raw, password, 'admin');
    };
    try {
      if (path === '/api/admin/show-audio' && request.method === 'POST') {
        if (!password) return json({ error: 'An admin password has not been configured.' }, 503);
        if (!originAllowed(request, url)) return json({ error: 'Submit changes from Mimi Admin settings.' }, 403);
        if (!await requireAdmin()) return json({ error: 'Sign in to Admin settings first.' }, 401);
        const content = await store.loadContent();
        if (content.narrationMode === 'dynamic') return json({ error: 'Narration is generated automatically for each new report.' }, 409);
        if (!speech) return json({ error: 'Narration needs the speech app credentials (VOLC_SPEECH_APP_ID / VOLC_SPEECH_ACCESS_TOKEN).' }, 503);
        const configured = await settings();
        const tts = {
          speaker: content.voice?.speaker?.trim() || configured.tts.speaker,
          speechRate: Number.isInteger(content.voice?.speechRate) ? content.voice.speechRate : configured.tts.speechRate ?? 0,
        };
        const segments = [{ id: 'ack', text: content.ack }];
        for (const item of content.narration ?? []) segments.push({ id: item.id, text: item.text });
        const failures = [];
        const synthesized = [];
        for (const { id, text } of segments) {
          try {
            const { audio } = await synthesizeSpeech(text, speech, { tts }, fetcher);
            synthesized.push({ id, bytes: Buffer.from(audio, 'base64') });
          } catch (error) {
            console.error(`[show tts ${id}]`, error instanceof Error ? error.message : error);
            failures.push({ id, error: `Could not synthesize “${id}”.` });
          }
        }
        if (failures.length) return json({ error: 'Some narration segments failed. The previous audio set was kept untouched — try again.', failures }, 502);
        await store.writeAudioAll(synthesized, content);
        return json({ ok: true, segments: synthesized.map(x => ({ id: x.id, ok: true })) });
      }

      if (!path.startsWith('/api/show/')) return json({ error: 'Show action not found.' }, 404);
      if (request.method !== 'GET' && !originAllowed(request, url)) return json({ error: 'Open Mimi directly to continue.' }, 403);
      const teacher = await requireTeacher();
      if (!teacher) return json({ error: 'Sign in with the teacher account to use the classroom show.' }, 401);

      if (path === '/api/show/desktop/open' && request.method === 'POST') {
        const { desktopId } = await request.json();
        if (typeof desktopId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(desktopId)) return json({ error: 'Invalid desktop session.' }, 400);
        const state = await store.openDesktop(desktopId, await loadSources?.());
        if (!state) return json({ error: '另一窗口正在使用大屏。关闭该窗口后即可进入。' }, 409);
        if (narrator) void narrator.ensure(state);
        warmOpening();
        return json({ version: state.version, resetEpoch: state.resetEpoch, active: state.active, preparing: state.preparing, dismissed: state.dismissed, checkpoint: state.checkpoint });
      }
      if (path === '/api/show/desktop/close' && request.method === 'POST') {
        const { desktopId } = await request.json();
        await store.closeDesktop(desktopId);
        return json({ ok: true });
      }

      if (path === '/api/show/reset' && request.method === 'POST') {
        const { requestId } = await request.json();
        if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) return json({ error: 'Invalid reset request.' }, 400);
        const state = await store.forceReset(requestId);
        narrator?.cancelBefore(state.version);
        if (narrator && state.desktop && !['ready', 'error'].includes(state.performance?.status)) void narrator.ensure(state);
        return json({ ok: true, version: state.version, resetEpoch: state.resetEpoch });
      }
      if (path === '/api/show/editor') {
        if (!sources) return json({ error: '当前服务不支持编辑课堂大屏。' }, 503);
        if (request.method === 'GET') return json(await sources.current());
        if (request.method === 'POST') {
          const input = await request.json();
          try { return json(await sources.save(input)); }
          catch (error) { return json({ error: error.message }, 400); }
        }
      }
      if (path === '/api/show/report' && request.method === 'GET') {
        const state = await store.state();
        if (Number(url.searchParams.get('version')) !== state.version) return json({ error: 'This report belongs to another session.' }, 409);
        const source = state.sources ?? await loadSources?.();
        if (!source?.html) return json({ error: 'The report is unavailable.' }, 404);
        const html = /<base\b/i.test(source.html) ? source.html : /<head\b[^>]*>/i.test(source.html)
          ? source.html.replace(/<head\b[^>]*>/i, '$&<base href="/">') : '<base href="/">' + source.html;
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      }

      if (path === '/api/show/say' && request.method === 'POST') {
        const input = await request.json().catch(() => ({}));
        const conversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : '';
        const text = typeof input.text === 'string' ? input.text.trim().slice(0, 500) : '';
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(conversationId) || !text) return json({ error: 'Say something first.' }, 400);
        const requestId = input.requestId ?? conversationId;
        if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) return json({ error: 'Invalid message.' }, 400);
        const result = await store.trigger(requestId, text, await loadSources?.(), input.resetEpoch ?? 0);
        if (result.stale) return json({ error: '大屏已重置，请重新输入指令。', resetEpoch: result.data.resetEpoch }, 409);
        if (result.busy) return json({ reply: 'The report is still playing.' });
        if (!result.created) return json({ reply: (await store.loadContent()).teacherLines.alreadyDone });
        if (narrator) void narrator.ensure(result.data);
        warmOpening();
        return json({ reply: (await store.loadContent()).teacherLines.acknowledged, version: result.data.version });
      }
      if (path === '/api/show/state' && request.method === 'GET') {
        warmOpening();
        const desktopId = url.searchParams.get('desktopId');
        const state = desktopId ? await store.touchDesktop(desktopId) : await store.state();
        if (!state) return json({ error: '大屏会话已结束，请重新进入课堂。', lostDesktop: true }, 409);
        const content = await store.loadContent();
        if (narrator && (state.active || state.preparing) && !['ready', 'error'].includes(state.performance?.status)) void narrator.ensure(state);
        return json({
          version: state.version, resetEpoch: state.resetEpoch, active: state.active, preparing: state.preparing, dismissed: state.dismissed, triggerText: state.triggerText,
          lastSegment: state.lastSegment, checkpoint: state.checkpoint, startedAt: state.startedAt, audioReady: content.narrationMode === 'dynamic' ? state.performance?.status === 'ready' : await store.audioReady(),
          narrationStatus: state.performance?.status, narrationError: state.performance?.error,
          contentRevision: await store.contentRevision?.(),
        });
      }
      if (path === '/api/show/opening' && request.method === 'GET') {
        const bytes = narrator ? await narrator.prepareOpening() : await store.readAudio('ack');
        if (!bytes) return json({ error: 'Mimi’s voice is not ready yet.' }, 503);
        return new Response(bytes, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
      }
      if (['/api/show/dismiss', '/api/show/retry'].includes(path) && request.method === 'POST') {
        const input = await request.json();
        const owner = (await store.state()).desktop;
        if (owner && input.desktopId !== owner.id) return json({ error: 'This desktop does not own the report.', lostDesktop: true }, 409);
        if (!Number.isInteger(input.version)) return json({ error: 'Invalid report.' }, 400);
        if (path.endsWith('/retry') && !narrator) return json({ error: 'Mimi cannot prepare the explanation right now.' }, 503);
        const state = path.endsWith('/dismiss') ? await store.dismiss(input.version) : await store.retry(input.version);
        if (!state) return json({ error: 'This report has changed. Please try again.' }, 409);
        if (path.endsWith('/retry') && narrator) void narrator.ensure(state);
        return json({ ok: true, version: state.version });
      }
      if (path === '/api/show/progress' && request.method === 'POST') {
        const input = await request.json().catch(() => ({}));
        const owner = (await store.state()).desktop;
        if (owner && input.desktopId !== owner.id) return json({ error: 'This desktop does not own the report.', lostDesktop: true }, 409);
        if (input.checkpoint) {
          const p = input.checkpoint;
          const content = await store.loadContent();
          const limit = p.phase === 'trace' ? content.traceSteps.length : p.phase === 'narration' ? (content.narrationMode === 'dynamic' ? 4 : content.narration.length) : 1;
          if (!Number.isInteger(input.version) || !['ack', 'trace', 'transition', 'narration', 'closing', 'done'].includes(p.phase) || !Number.isInteger(p.index) || p.index < 0 || p.index >= limit || !Number.isFinite(p.offset) || p.offset < 0 || p.offset > 3600) return json({ error: 'Invalid progress.' }, 400);
          if (content.narrationMode === 'dynamic' && p.phase === 'done') {
            const current = await store.state();
            if (current.version === input.version && current.active && (current.performance?.status !== 'ready' || !((current.checkpoint?.phase === 'narration' && current.checkpoint.index === 3) || current.checkpoint?.phase === 'closing'))) return json({ error: 'The spoken explanation has not finished.' }, 409);
          }
          if (!store.saveCheckpoint) return json({ error: 'The classroom show requires the Node server.' }, 503);
          await store.saveCheckpoint(input.version, { phase: p.phase, index: p.index, offset: p.offset });
          return json({ ok: true });
        }
        if (!Number.isInteger(input.version) || !Number.isInteger(input.segment) || input.segment < 0) return json({ error: 'Invalid progress.' }, 400);
        await store.saveProgress(input.version, input.segment);
        // The desktop reports one segment past the last when the show ends.
        try {
          const content = await store.loadContent();
          if (input.segment >= (content.narrationMode === 'dynamic' ? 4 : content.narration.length)) await store.finish(input.version);
        } catch { /* content problems must not block progress reporting */ }
        return json({ ok: true });
      }
      if (path === '/api/show/content' && request.method === 'GET') {
        let content = await store.loadContent();
        const state = await store.state();
        if (url.searchParams.has('version') && Number(url.searchParams.get('version')) !== state.version) return json({ error: 'This report has been replaced by a newer session.' }, 409);
        if (state.sources) {
          content = { ...content, artifact: { ...content.artifact, url: '/api/show/report?version=' + state.version } };
          if (state.sources.customHtml) content = {
            ...content, artifact: { ...content.artifact, title: 'Mimi · Classroom report' },
            traceSteps: ['Gathering my observations', 'Choosing the highlights', 'Arranging the report', 'Bringing it to the screen'],
            traceResults: ['My observations at hand', 'Relevant details in focus', 'Report in place', 'Ready to share'],
          };
        }
        return json(content.narrationMode === 'dynamic' ? { ...content, version: state.version, dismissed: state.dismissed, contentRevision: await store.contentRevision?.(), narration: state.performance?.narration ?? [], narrationStatus: state.performance?.status ?? 'pending', narrationError: state.performance?.error, audioReady: state.performance?.status === 'ready' } : content);
      }
      const audioMatch = path.match(/^\/api\/show\/audio\/([a-z0-9-]+)$/);
      if (audioMatch && request.method === 'GET') {
        const version = Number(url.searchParams.get('version'));
        const bytes = version ? await store.readPerformanceAudio?.(version, audioMatch[1]) : await store.readAudio(audioMatch[1]);
        if (!bytes) return json({ error: 'This narration segment is not available yet.' }, 404);
        return new Response(bytes, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
      }
      return json({ error: 'Show action not found.' }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not complete the classroom show request.';
      console.error('[show]', message);
      return json({ error: 'The classroom show could not complete the request.' }, 502);
    }
  };
}
