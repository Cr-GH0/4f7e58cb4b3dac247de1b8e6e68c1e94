// Classroom show — the teacher triggers a staged performance from a phone
// session; the desktop page (same teacher account, wide layout) polls the
// state endpoint and performs: ack, tool trace, report, narration. All content
// is prepared beforehand in show-content.json; nothing here reads student
// conversations. Create one handler per server so the desktop heartbeat lives
// for the process lifetime.
import { readTicket } from './admin-security.js';
import { currentStudent, TEACHER_NAMES } from './student-api.js';
import { synthesizeSpeech } from './public/talk-api.js';

const DESKTOP_ONLINE_MS = 3000;
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

export function createShowHandler({ store, students, secret, password, settings, speech, fetcher = fetch }) {
  let lastDesktopSeen = 0;
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
        await store.writeAudioAll(synthesized);
        return json({ ok: true, segments: synthesized.map(x => ({ id: x.id, ok: true })) });
      }

      if (!path.startsWith('/api/show/')) return json({ error: 'Show action not found.' }, 404);
      if (request.method !== 'GET' && !originAllowed(request, url)) return json({ error: 'Open Mimi directly to continue.' }, 403);
      const teacher = await requireTeacher();
      if (!teacher) return json({ error: 'Sign in with the teacher account to use the classroom show.' }, 401);

      if (path === '/api/show/say' && request.method === 'POST') {
        const input = await request.json().catch(() => ({}));
        const conversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : '';
        const text = typeof input.text === 'string' ? input.text.trim().slice(0, 500) : '';
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(conversationId) || !text) return json({ error: 'Say something first.' }, 400);
        // The desktop proves it is alive by polling /api/show/state.
        if (Date.now() - lastDesktopSeen > DESKTOP_ONLINE_MS) return json({ reply: (await store.loadContent()).teacherLines.desktopOffline });
        const result = await store.trigger(conversationId, text);
        if (!result.created) return json({ reply: (await store.loadContent()).teacherLines.alreadyDone });
        return json({ reply: (await store.loadContent()).teacherLines.acknowledged, version: result.data.version });
      }
      if (path === '/api/show/state' && request.method === 'GET') {
        lastDesktopSeen = Date.now();
        const state = await store.state();
        return json({
          version: state.version, active: state.active, triggerText: state.triggerText,
          lastSegment: state.lastSegment, startedAt: state.startedAt, audioReady: await store.audioReady(),
        });
      }
      if (path === '/api/show/progress' && request.method === 'POST') {
        const input = await request.json().catch(() => ({}));
        if (!Number.isInteger(input.version) || !Number.isInteger(input.segment) || input.segment < 0) return json({ error: 'Invalid progress.' }, 400);
        await store.saveProgress(input.version, input.segment);
        // The desktop reports one segment past the last when the show ends.
        try {
          const content = await store.loadContent();
          if (input.segment >= content.narration.length) await store.finish(input.version);
        } catch { /* content problems must not block progress reporting */ }
        return json({ ok: true });
      }
      if (path === '/api/show/content' && request.method === 'GET') {
        return json(await store.loadContent());
      }
      const audioMatch = path.match(/^\/api\/show\/audio\/([a-z0-9-]+)$/);
      if (audioMatch && request.method === 'GET') {
        const bytes = await store.readAudio(audioMatch[1]);
        if (!bytes) return json({ error: 'Narration audio is not available. Generate it in Admin settings.' }, 404);
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
