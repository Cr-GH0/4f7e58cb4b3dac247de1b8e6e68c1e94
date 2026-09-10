// Isolated show-state recovery checks. No live accounts or paid requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileShowStore } from './show-store-node.js';
import { createShowHandler } from './show-api.js';
import { createNarrationGenerator } from './show-narration.js';
import { fileStudentStore } from './student-store-node.js';
import { signTicket } from './admin-security.js';
import { defaultSettings } from './public/model-settings.js';

const contentPath = new URL('./show-content.json', import.meta.url);
const narration = ['intro', 'case1', 'case2', 'method'].map(id => ({ id, text: `Explanation for ${id}.` }));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const store = fileShowStore({ statePath: join(dir, 'state.json'), contentPath, audioDir: join(dir, 'audio') });
  const students = fileStudentStore(join(dir, 'students.json'));
  const teacher = await students.ensureTeacher('sunyumeng');
  const cookie = 'mimi_student=' + await signTicket({ purpose: 'student-login', studentId: teacher.id, expiresAt: Date.now() + 60_000 }, 'fixture');
  return { dir, store, students, cookie, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function caller(handler, cookie) {
  return (path, body) => handler(new Request('http://localhost' + path, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }));
}

test('dismiss is idempotent and makes same-version progress and performance writes terminal', async () => {
  const f = await fixture('mimi-show-dismiss-');
  try {
    const started = await f.store.trigger('conversation-a', 'Explain the report.', 'request-a');
    await f.store.savePerformance(started.data.version, { status: 'generating' });
    const first = await f.store.dismiss(started.data.version);
    assert.equal(first.active, false);
    assert.equal(first.dismissed, true);
    const again = await f.store.dismiss(started.data.version);
    assert.equal(again.active, false);
    assert.equal(again.dismissed, true);

    await f.store.savePerformance(started.data.version, { status: 'ready', narration });
    await f.store.saveCheckpoint(started.data.version, { phase: 'done', index: 0, offset: 0 });
    await f.store.finish(started.data.version);
    const afterLateWrites = await f.store.state();
    assert.equal(afterLateWrites.active, false);
    assert.equal(afterLateWrites.dismissed, true);
    assert.notEqual(afterLateWrites.performance?.status, 'ready');
  } finally { await f.cleanup(); }
});

test('dismiss and retry API reject stale versions; retry preserves narration and checkpoint', async () => {
  const f = await fixture('mimi-show-retry-');
  try {
    const fetcher = async (url, init) => {
      if (String(url).includes('chat/completions')) throw new Error('retry should reuse the saved narration');
      const body = JSON.parse(init.body);
      return Response.json({ code: 3000, data: Buffer.from(body.request.text).toString('base64') });
    };
    const handler = createShowHandler({
      store: f.store, students: f.students, secret: 'fixture', settings: async () => defaultSettings(),
      speech: { appId: 'fixture', token: 'fixture' }, arkKey: 'fixture', fetcher,
      loadSources: async () => ({ prompt: 'Return four English sections.', html: '<main>Report</main>' }),
    });
    const call = caller(handler, f.cookie);
    const started = await f.store.trigger('conversation-a', 'Explain the report.', 'request-a');
    const checkpoint = { phase: 'narration', index: 1, offset: 4.25 };
    await f.store.saveCheckpoint(started.data.version, checkpoint);
    await f.store.savePerformance(started.data.version, { status: 'error', error: 'Speech failed.', narration });

    assert.equal((await call('/api/show/retry', { version: 999 })).status, 409);
    const retried = await call('/api/show/retry', { version: started.data.version });
    assert.equal(retried.status, 200);
    let state;
    for (let i = 0; i < 100; i++) {
      state = await f.store.state();
      if (state.performance?.status === 'ready') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(state.performance.status, 'ready');
    assert.deepEqual(state.performance.narration, narration);
    assert.deepEqual(state.checkpoint, checkpoint);

    assert.equal((await call('/api/show/dismiss', { version: 999 })).status, 409);
    assert.equal((await call('/api/show/dismiss', { version: started.data.version })).status, 200);
    assert.equal((await call('/api/show/dismiss', { version: started.data.version })).status, 200);
  } finally { await f.cleanup(); }
});

test('a dismissed generation cannot publish late narration or audio', async () => {
  const f = await fixture('mimi-show-late-generation-');
  const model = deferred();
  try {
    const fetcher = async url => {
      if (String(url).includes('chat/completions')) return model.promise;
      return Response.json({ code: 3000, data: Buffer.from('audio').toString('base64') });
    };
    const generator = createNarrationGenerator({
      store: f.store, settings: async () => defaultSettings(), speech: { appId: 'fixture', token: 'fixture' }, arkKey: 'fixture', fetcher,
      loadSources: async () => ({ prompt: 'Return four English sections.', html: '<main>Report</main>' }),
    });
    const started = await f.store.trigger('conversation-a', 'Explain the report.', 'request-a');
    const job = generator.ensure(started.data);
    while ((await f.store.state()).performance?.status !== 'generating') await new Promise(resolve => setTimeout(resolve, 1));
    await f.store.dismiss(started.data.version);
    model.resolve(Response.json({ choices: [{ message: { content: JSON.stringify({ narration }) } }] }));
    await job;

    const state = await f.store.state();
    assert.equal(state.active, false);
    assert.equal(state.dismissed, true);
    assert.notEqual(state.performance?.status, 'ready');
    assert.equal(await f.store.readPerformanceAudio(started.data.version, 'intro'), null);
    await generator.ensure(state);
    assert.notEqual((await f.store.state()).performance?.status, 'ready');
  } finally { await f.cleanup(); }
});

test('requestId deduplicates retries but a completed conversation may start a new request', async () => {
  const f = await fixture('mimi-show-request-id-');
  try {
    const handler = createShowHandler({ store: f.store, students: f.students, secret: 'fixture' });
    const call = caller(handler, f.cookie);
    const first = await (await call('/api/show/say', { conversationId: 'same-conversation', requestId: 'request-a', text: 'Explain it.' })).json();
    assert.equal(first.version, 1);
    await f.store.finish(1);
    const duplicate = await (await call('/api/show/say', { conversationId: 'same-conversation', requestId: 'request-a', text: 'Explain it.' })).json();
    assert.equal(duplicate.version, undefined);
    const second = await (await call('/api/show/say', { conversationId: 'same-conversation', requestId: 'request-b', text: 'Explain it again.' })).json();
    assert.equal(second.version, 2);
  } finally { await f.cleanup(); }
});

test('opening audio is cached independently and does not generate a report', async () => {
  const f = await fixture('mimi-show-opening-');
  try {
    let speechCalls = 0, sourceCalls = 0;
    const options = {
      store: f.store, settings: async () => defaultSettings(), speech: { appId: 'fixture', token: 'fixture' }, arkKey: 'fixture',
      loadSources: async () => { sourceCalls++; return { prompt: 'unused', html: '<main>unused</main>' }; },
      fetcher: async url => {
        assert.ok(!String(url).includes('chat/completions'));
        speechCalls++;
        return Response.json({ code: 3000, data: Buffer.from('cached opening').toString('base64') });
      },
    };
    const first = await createNarrationGenerator(options).prepareOpening();
    const second = await createNarrationGenerator({ ...options, fetcher: async () => { throw new Error('cache miss'); } }).prepareOpening();
    assert.equal(Buffer.from(first).toString(), 'cached opening');
    assert.equal(Buffer.from(second).toString(), 'cached opening');
    assert.equal(speechCalls, 1);
    assert.equal(sourceCalls, 0);
    assert.equal((await f.store.state()).version, 0);
  } finally { await f.cleanup(); }
});

test('report generation retries one transient LLM failure and then becomes ready', async () => {
  const f = await fixture('mimi-show-llm-retry-');
  try {
    let modelCalls = 0, speechCalls = 0;
    const generator = createNarrationGenerator({
      store: f.store, settings: async () => defaultSettings(), speech: { appId: 'fixture', token: 'fixture' }, arkKey: 'fixture',
      loadSources: async () => ({ prompt: 'Return four English sections.', html: '<main>Report</main>' }),
      fetcher: async url => {
        if (String(url).includes('chat/completions')) {
          modelCalls++;
          if (modelCalls === 1) throw new Error('transient model failure');
          return Response.json({ choices: [{ message: { content: JSON.stringify({ narration }) } }] });
        }
        speechCalls++;
        return Response.json({ code: 3000, data: Buffer.from('audio').toString('base64') });
      },
    });
    const started = await f.store.trigger('request-a', 'Explain the report.');
    await generator.ensure(started.data);
    assert.equal((await f.store.state()).performance.status, 'ready');
    assert.equal(modelCalls, 2);
    assert.equal(speechCalls, 4);
  } finally { await f.cleanup(); }
});

test('report generation retries one transient TTS failure without regenerating narration', async () => {
  const f = await fixture('mimi-show-tts-retry-');
  try {
    let modelCalls = 0;
    const speechCalls = new Map();
    const generator = createNarrationGenerator({
      store: f.store, settings: async () => defaultSettings(), speech: { appId: 'fixture', token: 'fixture' }, arkKey: 'fixture',
      loadSources: async () => ({ prompt: 'Return four English sections.', html: '<main>Report</main>' }),
      fetcher: async (url, init) => {
        if (String(url).includes('chat/completions')) {
          modelCalls++;
          return Response.json({ choices: [{ message: { content: JSON.stringify({ narration }) } }] });
        }
        const text = JSON.parse(init.body).request.text;
        const count = (speechCalls.get(text) ?? 0) + 1;
        speechCalls.set(text, count);
        if (text === narration[1].text && count === 1) throw new Error('transient speech failure');
        return Response.json({ code: 3000, data: Buffer.from(text).toString('base64') });
      },
    });
    const started = await f.store.trigger('request-a', 'Explain the report.');
    await generator.ensure(started.data);
    assert.equal((await f.store.state()).performance.status, 'ready');
    assert.equal(modelCalls, 1);
    assert.equal(speechCalls.get(narration[1].text), 2);
    assert.equal([...speechCalls.values()].reduce((sum, count) => sum + count, 0), 5);
  } finally { await f.cleanup(); }
});

test('a dismissed in-flight TTS batch cannot publish any report audio', async () => {
  const f = await fixture('mimi-show-late-tts-');
  const heldSpeech = deferred();
  try {
    let speechCalls = 0;
    const generator = createNarrationGenerator({
      store: f.store, settings: async () => defaultSettings(), speech: { appId: 'fixture', token: 'fixture' }, arkKey: 'fixture',
      loadSources: async () => ({ prompt: 'unused', html: '<main>Report</main>' }),
      fetcher: async () => {
        speechCalls++;
        if (speechCalls === 1) return heldSpeech.promise;
        return Response.json({ code: 3000, data: Buffer.from('audio').toString('base64') });
      },
    });
    const started = await f.store.trigger('request-a', 'Explain the report.');
    await f.store.savePerformance(started.data.version, { status: 'pending', narration });
    const job = generator.ensure(await f.store.state());
    while (speechCalls < 4) await new Promise(resolve => setTimeout(resolve, 1));
    await f.store.dismiss(started.data.version);
    heldSpeech.resolve(Response.json({ code: 3000, data: Buffer.from('late audio').toString('base64') }));
    await job;
    for (const item of narration) assert.equal(await f.store.readPerformanceAudio(started.data.version, item.id), null);
    const state = await f.store.state();
    assert.equal(state.dismissed, true);
    assert.notEqual(state.performance?.status, 'ready');
  } finally { await f.cleanup(); }
});

test('retry without a narrator reports unavailable and leaves the recoverable error intact', async () => {
  const f = await fixture('mimi-show-retry-unavailable-');
  try {
    const started = await f.store.trigger('request-a', 'Explain the report.');
    await f.store.savePerformance(started.data.version, { status: 'error', error: 'Generation failed.' });
    const call = caller(createShowHandler({ store: f.store, students: f.students, secret: 'fixture' }), f.cookie);
    assert.equal((await call('/api/show/retry', { version: started.data.version })).status, 503);
    const state = await f.store.state();
    assert.equal(state.active, true);
    assert.equal(state.performance.status, 'error');
    assert.equal(state.performance.error, 'Generation failed.');
  } finally { await f.cleanup(); }
});


test('opening a desktop clears the previous performance and allows the next request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mimi-desktop-open-'));
  try {
    const store = fileShowStore({ statePath: join(dir, 'state.json'), contentPath: new URL('./show-content.json', import.meta.url), audioDir: join(dir, 'audio') });
    await store.trigger('old-request', 'Explain the report.');
    await store.saveCheckpoint(1, { phase: 'narration', index: 2, offset: 10 });
    await store.savePerformance(1, { status: 'generating' });
    const reset = await store.openDesktop('desktop-owner');
    assert.equal(reset.active, false);
    assert.equal(reset.dismissed, false);
    assert.equal(reset.preparing, true);
    assert.equal(reset.checkpoint, null);
    await store.savePerformance(1, { status: 'ready' });
    await store.saveCheckpoint(1, { phase: 'done', index: 0, offset: 0 });
    assert.equal((await store.state()).performance, null, 'late generation cannot restore a closed session');
    const next = await store.trigger('next-request', 'Explain the report.');
    assert.equal(next.created, true);
    assert.equal(next.data.version, 2);
    assert.deepEqual(next.data.checkpoint, { phase: 'ack', index: 0, offset: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a live desktop owns its prepared round; second windows and late closes cannot reset it', async t => {
  const f = await fixture('mimi-show-owner-');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  try {
    const source = { html: '<main>Current report</main>', prompt: 'Current instructions' };
    const first = await f.store.openDesktop('first-desktop', source);
    await f.store.savePerformance(first.version, { status: 'ready', narration });
    assert.equal(await f.store.openDesktop('second-desktop', source), null);
    assert.equal(await f.store.closeDesktop('second-desktop'), null);
    assert.equal((await f.store.state()).performance.status, 'ready');
    const trigger = await f.store.trigger('one-teacher-utterance', 'What did you notice?', { html: 'new', prompt: 'new' });
    assert.equal(trigger.data.version, first.version, 'trigger reuses prepared audio and report');
    assert.deepEqual(trigger.data.sources, source);
    assert.deepEqual(trigger.data.performance.narration, narration);
    now += 16000;
    const replacement = await f.store.openDesktop('replacement-desktop', source);
    assert.equal(replacement.version, first.version + 1);
    assert.equal(replacement.active, false);
    assert.equal(await f.store.closeDesktop('first-desktop'), null);
    await f.store.savePerformance(first.version, { status: 'ready', narration });
    assert.equal((await f.store.state()).performance, null);
    const handler = createShowHandler({ store: f.store, students: f.students, secret: 'fixture' });
    assert.equal((await caller(handler, f.cookie)('/api/show/dismiss', { version: replacement.version, desktopId: 'first-desktop' })).status, 409);
  } finally { await f.cleanup(); }
});
