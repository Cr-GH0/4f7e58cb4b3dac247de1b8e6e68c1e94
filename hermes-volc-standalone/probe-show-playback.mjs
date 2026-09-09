// Isolated regression checks: no live accounts, TTS, RTC or paid requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileShowStore } from './show-store-node.js';
import { fileStudentStore } from './student-store-node.js';
import { createShowHandler } from './show-api.js';
import { signTicket } from './admin-security.js';
import { ShowAudio } from './public/show-audio.js';
import { mountTeacherConsole } from './public/teacher-console.js';

const configuredContent = JSON.parse(await readFile(new URL('./show-content.json', import.meta.url), 'utf8'));
const content = { ...configuredContent, narrationMode: 'static', artifact: undefined, narration: ['intro','case1','case2','method'].map(id => ({ id, text: 'The ' + id + ' explanation.' })) };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
  const deadline = Date.now() + 3500;
  while (!predicate() && Date.now() < deadline) await pause(5);
  assert.ok(predicate(), message);
}

test('no audio or desktop-preparation gate; duplicate trigger and persisted checkpoints', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mimi-playback-'));
  try {
    const contentPath = join(dir, 'content.json');
    await writeFile(contentPath, JSON.stringify(content));
    const options = { contentPath, statePath: join(dir, 'state.json'), audioDir: join(dir, 'audio') };
    const store = fileShowStore(options);
    const students = fileStudentStore(join(dir, 'students.json'));
    const teacher = await students.ensureTeacher('sunyumeng');
    const cookie = 'mimi_student=' + await signTicket({ purpose: 'student-login', studentId: teacher.id, expiresAt: Date.now() + 60000 }, 'test');
    const handler = createShowHandler({ store, students, secret: 'test', password: '', settings: async () => ({}), speech: null });
    const call = async (path, body) => {
      const response = await handler(new Request('https://test.invalid' + path, { method: body ? 'POST' : 'GET', headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }));
      return { status: response.status, data: await response.json() };
    };
    // No desktop heartbeat, no audio, no preparation gesture: the request is accepted.
    assert.equal((await call('/api/show/say', { conversationId: 'a', text: '总结' })).data.version, 1);
    assert.match((await call('/api/show/say', { conversationId: 'b', text: '总结' })).data.reply, /still playing/);
    assert.match((await call('/api/show/say', { conversationId: 'a', text: '总结' })).data.reply, /report is ready/);
    await store.writeAudioAll(['ack', ...content.narration.map(s => s.id)].map(id => ({ id, bytes: Buffer.from('fixture') })), content);
    assert.equal(await store.audioReady(), true);
    const point = { phase: 'narration', index: 0, offset: 4.2 };
    assert.equal((await call('/api/show/progress', { version: 1, checkpoint: point })).status, 200);
    await call('/api/show/progress', { version: 1, checkpoint: { ...point, offset: 1 } });
    assert.deepEqual((await fileShowStore(options).state()).checkpoint, point, 'late progress cannot rewind playback');
    assert.equal((await call('/api/show/progress', { version: 1, checkpoint: { ...point, index: 999 } })).status, 400);
    await call('/api/show/progress', { version: 1, checkpoint: { phase: 'done', index: 0, offset: 0 } });
    assert.equal((await store.state()).active, false);
    assert.equal((await call('/api/show/say', { conversationId: 'b', text: '再来一次' })).data.version, 2);
    const changed = structuredClone(content); changed.narration[0].text += '新文案';
    await pause(15);
    await writeFile(contentPath, JSON.stringify(changed));
    assert.equal(await store.audioReady(), false, 'old audio cannot qualify for edited narration');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

class Context {
  constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.events = new Map(); this.sources = []; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
  async decodeAudioData() { return { duration: 30 }; }
  addEventListener(type, fn) { this.events.set(type, fn); }
  removeEventListener(type, fn) { if (this.events.get(type) === fn) this.events.delete(type); }
  createBufferSource() {
    const source = { connect() {}, disconnect() {}, stop() {}, start(when, offset) { this.offset = offset; }, onended: null };
    this.sources.push(source); return source;
  }
  createAnalyser() {
    const ctx = this;
    return { fftSize: 256, connect() {}, disconnect() {}, getByteTimeDomainData(samples) { samples.fill(128 + (ctx.amplitude ?? 24)); } };
  }
  suspendNow() { this.state = 'suspended'; this.events.get('statechange')?.(); }
}

test('audio is decoded in advance; interruption rejects without silently advancing; resume preserves seconds', async () => {
  const ctx = new Context();
  const audio = new ShowAudio({ contextFactory: () => ctx, fetcher: async () => new Response(new Uint8Array([1])) });
  await audio.prepare(content);
  await assert.rejects(audio.play('intro'), /unavailable/);
  await audio.arm();
  let offset;
  const interrupted = audio.play('intro', 3, value => { offset = value; });
  const rejection = assert.rejects(interrupted, /interrupted/);
  ctx.currentTime = 2;
  ctx.suspendNow();
  await rejection;
  assert.equal(offset, 5);
  await audio.arm();
  const completed = audio.play('intro', offset);
  assert.equal(ctx.sources.at(-1).offset, 5);
  ctx.sources.at(-1).onended();
  await completed;
  audio.dispose();
});

test('default browser fetch keeps the Window receiver when loading narration audio', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = function (url, options) {
    if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    calls.push({ url, options });
    return Promise.resolve(new Response(new Uint8Array([1])));
  };
  const audio = new ShowAudio({ contextFactory: () => new Context() });
  try {
    await audio.prepare({ ...content, version: 5 });
    assert.equal(audio.buffers.size, 5, 'ack and every narration segment are loaded');
    assert.deepEqual(calls.map(call => call.url), ['ack', ...content.narration.map(s => s.id)].map(id => '/api/show/audio/' + id + '?version=5'));
    assert.ok(calls.every(call => call.options.cache === 'no-store'));
  } finally {
    audio.dispose();
    globalThis.fetch = originalFetch;
  }
});


test('missing audio fails preparation instead of falling back to silent timers', async () => {
  const audio = new ShowAudio({ contextFactory: () => new Context(), fetcher: async () => new Response('', { status: 404 }) });
  await assert.rejects(audio.prepare(content), /unavailable/);
  assert.equal(audio.buffers.size, 0);
  audio.dispose();
});

function consoleFixture({ snapshot = { version: 0, active: false }, saved = null, phone = false, narrowDesktop = false, blocked = false, runtimeContent } = {}) {
  const originals = Object.fromEntries(['window', 'document', 'matchMedia', 'fetch'].map(k => [k, globalThis[k]]));
  const ctx = new Context();
  if (blocked) ctx.resume = async () => { throw new Error('Autoplay blocked'); };
  let generated = runtimeContent ?? { ...configuredContent, version: snapshot.version, narration: content.narration, narrationStatus: 'ready', audioReady: true };
  const memory = new Map(saved ? [['mimi.show.checkpoint.v2', JSON.stringify(saved)]] : []);
  const storage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) };
  const listeners = new Map(), inputEvents = new Map();
  const input = { value: '', addEventListener: (type, fn) => inputEvents.set(type, fn), focus() {}, setSelectionRange() {} };
  const classes = new Set(), styles = new Map(), sectionVisits = [], embeddedStyles = [];
  let stage = null, frame = null, markup = '', reportMarkup = '', reportWrites = 0, hostWrites = 0, offline = false;
  const presence = { style: { setProperty: (k, v) => styles.set(k, v) }, setAttribute() {} };
  const notice = { hidden: true, textContent: '' };
  const frameDoc = {
    getElementById: id => embeddedStyles.find(s => s.id === id), createElement: () => ({}), head: { append: s => embeddedStyles.push(s) },
    scrollingElement: { scrollTop: 0 }, querySelectorAll: () => ['case1','case2'].map(id => ({ scrollIntoView: () => sectionVisits.push(id) })),
    querySelector: () => ({ scrollIntoView: () => sectionVisits.push('method') }),
  };
  const report = {
    hidden: true,
    get innerHTML() { return reportMarkup; },
    set innerHTML(value) {
      reportMarkup = value; reportWrites++;
      const src = value.match(/src="([^"]+)"/)[1];
      frame = { getAttribute: () => src, contentDocument: frameDoc, addEventListener: (type, fn) => { if (type === 'load') queueMicrotask(fn); } };
    },
    querySelector: () => frame,
  };
  const host = {
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value; hostWrites++;
      if (value.includes('data-mimi-stage')) stage = {
        dataset: { phase: 'idle' }, classList: { toggle: (k, v) => v ? classes.add(k) : classes.delete(k), contains: k => classes.has(k) },
        querySelector: s => s === '[data-mimi-presence]' ? presence : s === '[data-mimi-error]' ? notice : s === '[data-mimi-report]' ? report : null,
      }; else stage = null;
    },
    contains: () => false, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type),
    querySelector: s => s === '[data-mimi-stage]' ? stage : s === '[data-mimi-presence]' ? presence : s === '[data-mimi-report-frame]' ? frame : s === '[data-tc-input]' && markup.includes('<textarea') ? input : null,
  };
  const progress = [], calls = [];
  globalThis.window = { AudioContext: function () { return ctx; } };
  globalThis.document = { activeElement: null, hidden: false, addEventListener() {}, removeEventListener() {} };
  globalThis.matchMedia = query => ({ matches: !phone && (!narrowDesktop || query.includes('pointer')), addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = async (path, options = {}) => {
    calls.push(path);
    if (offline) throw new Error('offline');
    if (path === '/api/show/progress') { progress.push(JSON.parse(options.body)); return Response.json({ ok: true }); }
    if (path === '/api/show/say') { calls.push(JSON.parse(options.body)); return Response.json({ reply: 'I’m preparing the report.', version: 1 }); }
    if (path.startsWith('/api/show/state')) return Response.json(snapshot);
    if (path.startsWith('/api/show/content')) return Response.json(generated);
    if (path.startsWith('/api/show/audio/')) return new Response(new Uint8Array([1]));
    return Response.json({});
  };
  const dispose = mountTeacherConsole(host, { storage });
  return { host, ctx, progress, memory, snapshot, report, notice, styles, sectionVisits, calls, embeddedStyles,
    stage: () => stage, frame: () => frame, writes: () => ({ reportWrites, hostWrites }), setContent: value => { generated = value; },
    offline: value => { offline = value; }, interact: () => listeners.get('keydown')?.(),
    type: value => { input.value = value; inputEvents.get('input')(); }, enter: () => inputEvents.get('keydown')({ key: 'Enter', shiftKey: false, preventDefault() {} }),
    cleanup: async () => { dispose(); await pause(30); for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } },
  };
}

test('idle desktop shows only the avatar, including in a narrow desktop window', async () => {
  const f = consoleFixture({ narrowDesktop: true });
  try {
    await until(() => f.calls.includes('/api/show/state'), 'desktop listens for the phone');
    assert.equal(f.stage().dataset.phase, 'idle');
    assert.ok(f.host.innerHTML.includes('src="/mimi.png"'));
    assert.ok(!/<textarea|<button|tc-chat|tc-header/.test(f.host.innerHTML));
    assert.equal(f.report.hidden, true);
    assert.equal(f.ctx.sources.length, 0);
  } finally { await f.cleanup(); }
});

test('phone retains auto-created sessions and sends the summary command without playing desktop audio', async () => {
  const f = consoleFixture({ phone: true });
  try {
    assert.ok(f.host.innerHTML.includes('<textarea'));
    f.type('Please summarize the practice.'); f.enter();
    await until(() => f.host.innerHTML.includes('preparing the report'), 'phone receives acknowledgement');
    const sent = f.calls.find(c => typeof c === 'object');
    assert.equal(sent.text, 'Please summarize the practice.');
    assert.ok(sent.conversationId);
    assert.ok(JSON.parse(f.memory.get('mimi.teacher.v1')).list[0].lines.length === 2);
    assert.ok(!f.calls.includes('/api/show/state'));
    assert.equal(f.ctx.sources.length, 0);
  } finally { await f.cleanup(); }
});

test('phone trigger moves from generating avatar to full-window report and real spoken animation', async () => {
  const state = { version: 0, active: false };
  const ready = { ...configuredContent, version: 1, narration: content.narration, narrationStatus: 'ready', audioReady: true };
  const f = consoleFixture({ snapshot: state, runtimeContent: { ...ready, narration: [], narrationStatus: 'generating', audioReady: false } });
  try {
    Object.assign(state, { version: 1, active: true, checkpoint: { phase: 'ack', index: 0, offset: 0 } });
    await until(() => f.stage().dataset.phase === 'generating', 'avatar shows generation');
    assert.equal(f.report.hidden, true);
    f.setContent(ready);
    await until(() => f.ctx.sources.length === 1, 'speech begins automatically');
    assert.equal(f.stage().dataset.phase, 'speaking');
    assert.ok(f.stage().classList.contains('has-report'));
    assert.match(f.report.innerHTML, /src="\/practice-report.html"/);
    assert.ok(!/tc-chat|textarea|View steps|Download|Close/.test(f.host.innerHTML));
    for (const item of ready.narration) assert.ok(!f.host.innerHTML.includes(item.text), 'no narration text on the desktop');
    const frame = f.frame(), stage = f.stage();
    await until(() => Number(f.styles.get('--voice-level')) > 0, 'avatar responds to the audio signal');
    f.ctx.amplitude = 0;
    await until(() => Number(f.styles.get('--voice-level')) === 0, 'silence lowers the signal');
    for (let i = 0; i < 4; i++) {
      await until(() => f.ctx.sources.length === i + 1, 'next spoken section');
      assert.equal(f.frame(), frame); assert.equal(f.stage(), stage);
      f.ctx.sources[i].onended();
    }
    await until(() => f.progress.some(p => p.checkpoint.phase === 'done'), 'ends only after audio ends');
    assert.equal(f.stage().dataset.phase, 'idle');
    assert.equal(f.report.hidden, false);
    assert.deepEqual(f.writes(), { reportWrites: 1, hostWrites: 1 });
    assert.deepEqual(f.sectionVisits, ['case1','case2','method']);
    assert.ok(f.embeddedStyles[0].textContent.includes('padding-right:max'));
    f.setContent({ ...ready, version: 2 });
    Object.assign(state, { version: 2, active: true, checkpoint: { phase: 'ack', index: 0, offset: 0 } });
    await until(() => f.ctx.sources.length === 5, 'a new performance begins');
    assert.equal(f.stage(), stage, 'avatar stays mounted');
    assert.notEqual(f.frame(), frame, 'new performance reloads the current artifact');
    assert.deepEqual(f.writes(), { reportWrites: 2, hostWrites: 1 });
  } finally { await f.cleanup(); }
});

test('blocked audio keeps the full report and checkpoint, then resumes automatically', async () => {
  const f = consoleFixture({ blocked: true, snapshot: { version: 1, active: true, narrationStatus: 'ready', checkpoint: { phase: 'narration', index: 1, offset: 4.2 } } });
  try {
    await until(() => f.stage().dataset.phase === 'paused', 'audio pause is represented accurately');
    assert.equal(f.report.hidden, false);
    assert.equal(f.ctx.sources.length, 0);
    assert.ok(!f.progress.some(p => p.checkpoint.phase === 'done'));
    f.ctx.resume = async () => { f.ctx.state = 'running'; };
    await until(() => f.ctx.sources.length === 1, 'automatic retry resumes the saved position');
    assert.equal(f.ctx.sources[0].offset, 4.2);
    assert.equal(f.stage().dataset.phase, 'speaking');
  } finally { await f.cleanup(); }
});

test('stale local completion cannot skip an unplayed report; fresh local offsets are preserved', async () => {
  const f = consoleFixture({ snapshot: { version: 1, active: true, checkpoint: { phase: 'narration', index: 0, offset: 2 } }, saved: { version: 1, checkpoint: { phase: 'done', index: 0, offset: 0 } } });
  try {
    await until(() => f.ctx.sources.length === 1, 'unplayed narration starts');
    assert.equal(f.ctx.sources[0].offset, 2);
    assert.ok(!f.progress.some(p => p.checkpoint.phase === 'done'));
  } finally { await f.cleanup(); }
  const resumed = consoleFixture({ snapshot: { version: 1, active: true, checkpoint: { phase: 'narration', index: 1, offset: 2 } }, saved: { version: 1, checkpoint: { phase: 'narration', index: 1, offset: 6.5 } } });
  try {
    await until(() => resumed.ctx.sources.length === 1, 'local checkpoint restored');
    assert.equal(resumed.ctx.sources[0].offset, 6.5);
  } finally { await resumed.cleanup(); }
});

test('completed report refresh keeps the artifact with an idle corner avatar and no replay', async () => {
  const f = consoleFixture({ snapshot: { version: 1, active: false, checkpoint: { phase: 'done', index: 0, offset: 0 } } });
  try {
    await until(() => f.frame(), 'report is restored');
    assert.equal(f.stage().dataset.phase, 'idle');
    assert.ok(f.stage().classList.contains('has-report'));
    assert.equal(f.ctx.sources.length, 0);
    assert.equal(f.report.hidden, false);
    for (const segment of content.narration) assert.ok(!f.host.innerHTML.includes(segment.text));
  } finally { await f.cleanup(); }
});
