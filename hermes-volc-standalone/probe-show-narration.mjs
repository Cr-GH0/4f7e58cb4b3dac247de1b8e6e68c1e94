import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNarrationGenerator, parseNarration, reportText } from './show-narration.js';
import { fileShowStore } from './show-store-node.js';
import { fileShowSources } from './show-sources-node.js';
import { defaultSettings } from './public/model-settings.js';
import { fileStudentStore } from './student-store-node.js';
import { signTicket } from './admin-security.js';
import { createShowHandler } from './show-api.js';

const currentPrompt = await readFile(new URL('./show-narration-prompt.md', import.meta.url), 'utf8');
const currentReport = await readFile(new URL('./public/practice-report.html', import.meta.url), 'utf8');
const currentContent = JSON.parse(await readFile(new URL('./show-content.json', import.meta.url), 'utf8'));

test('two performances generate fresh wording, while refresh reuses exact spoken text and audio', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mimi-narration-'));
  const store = fileShowStore({ statePath: join(dir, 'state.json'), contentPath: new URL('./show-content.json', import.meta.url), audioDir: join(dir, 'audio') });
  let calls = 0;
  const spoken = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.includes('chat/completions')) {
      calls++;
      assert.ok(body.messages[0].content.startsWith(currentPrompt + '\n\n'));
      assert.equal(JSON.parse(body.messages[1].content).report, reportText(currentReport));
      assert.ok(!body.messages[1].content.includes('<style>'));
      return Response.json({ choices: [{ message: { content: JSON.stringify({ narration: ['intro','case1','case2','method'].map(id => ({ id, text: `Explanation ${calls} for ${id}.` })) }) } }] });
    }
    spoken.push(body.request.text);
    return Response.json({ code: 3000, data: Buffer.from('audio fixture').toString('base64') });
  };
  const generator = createNarrationGenerator({ store, settings: async () => defaultSettings(), speech: { appId: 'fixture', token: 'fixture' }, arkKey: 'fixture', fetcher,
    loadSources: async () => ({ prompt: await readFile(new URL('./show-narration-prompt.md', import.meta.url), 'utf8'), html: await readFile(new URL('./public/practice-report.html', import.meta.url), 'utf8') }) });
  try {
    const first = await store.trigger('one', 'Explain the report.');
    await Promise.all([generator.ensure(first.data), generator.ensure(first.data)]);
    const state1 = await store.state();
    assert.equal(state1.performance.status, 'ready');
    assert.equal(calls, 1);
    assert.deepEqual(spoken, state1.performance.narration.map(s => s.text));
    await generator.ensure(state1);
    assert.equal(calls, 1, 'refresh does not regenerate');
    await store.finish(1);
    const second = await store.trigger('two', 'Explain the report.');
    await generator.ensure(second.data);
    const state2 = await store.state();
    assert.equal(calls, 2);
    assert.notDeepEqual(state1.performance.narration, state2.performance.narration);
    assert.ok((await store.readPerformanceAudio(1, 'case1')).length);
    assert.ok((await store.readPerformanceAudio(2, 'case1')).length);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('oversized or malformed model paragraphs are rejected, never silently truncated for speech', () => {
  const items = ['intro','case1','case2','method'].map(id => ({ id, text: 'An explanation.' }));
  assert.equal(parseNarration(JSON.stringify({ narration: items })).length, 4);
  items[1].text = 'a'.repeat(901);
  assert.throws(() => parseNarration(JSON.stringify({ narration: items })), /speech service/);
  assert.throws(() => parseNarration('{}'));
});

test('dynamic API serves matching versioned text/audio and refuses premature completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mimi-narration-api-'));
  try {
    const store = fileShowStore({ statePath: join(dir, 'state.json'), contentPath: new URL('./show-content.json', import.meta.url), audioDir: join(dir, 'audio') });
    const students = fileStudentStore(join(dir, 'students.json'));
    const teacher = await students.ensureTeacher('sunyumeng');
    const cookie = 'mimi_student=' + await signTicket({ purpose: 'student-login', studentId: teacher.id, expiresAt: Date.now() + 60000 }, 'fixture');
    const handler = createShowHandler({ store, students, secret: 'fixture' });
    const call = (path, body) => handler(new Request('http://localhost' + path, { method: body ? 'POST' : 'GET', headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }));
    await store.trigger('api', 'Explain the report.');
    const done = { version: 1, checkpoint: { phase: 'done', index: 0, offset: 0 } };
    assert.equal((await call('/api/show/progress', done)).status, 409);
    assert.equal((await store.state()).active, true);
    const narration = ['intro','case1','case2','method'].map(id => ({ id, text: 'The ' + id + ' explanation.' }));
    await store.writePerformanceAudio(1, narration.map(s => ({ id: s.id, bytes: Buffer.from(s.text) })));
    await store.savePerformance(1, { status: 'ready', narration });
    const result = await (await call('/api/show/content?version=1')).json();
    assert.deepEqual(result.narration, narration);
    assert.equal(result.audioReady, true);
    assert.equal((await call('/api/show/content?version=2')).status, 409);
    assert.equal(await (await call('/api/show/audio/case1?version=1')).text(), narration[1].text);
    assert.equal((await call('/api/show/audio/case1?version=2')).status, 404);
    assert.equal((await call('/api/show/progress', done)).status, 409);
    await call('/api/show/progress', { version: 1, checkpoint: { phase: 'narration', index: 3, offset: 10 } });
    assert.equal((await call('/api/show/progress', done)).status, 200);
    assert.equal((await store.state()).active, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the displayed HTML and report metadata use the same current case quotations', async () => {
  const html = await readFile(new URL('./public/practice-report.html', import.meta.url), 'utf8');
  const text = reportText(html);
  assert.ok(!html.includes('<p class="reading-note"'));
  assert.ok(!text.includes('the claims have no content'));
  assert.equal(currentContent.report.cases.length, 2);
  for (const item of currentContent.report.cases) {
    assert.ok(text.includes(item.original));
    assert.ok(text.includes(item.revised));
  }
  assert.ok(text.includes(currentContent.report.title));
  assert.ok(html.includes('class="method"'));
});

test('editor saves persist and each round uses its own matching HTML and speaking instructions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mimi-editor-'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const modelBodies = [];
  try {
    const htmlPath = join(dir, 'default.html'), promptPath = join(dir, 'default.md');
    await writeFile(htmlPath, '<html><head></head><body>Default report</body></html>');
    await writeFile(promptPath, 'Default instructions');
    const options = { path: join(dir, 'sources.json'), htmlPath, promptPath };
    const sources = fileShowSources(options);
    const store = fileShowStore({ statePath: join(dir, 'state.json'), contentPath: new URL('./show-content.json', import.meta.url), audioDir: join(dir, 'audio') });
    const students = fileStudentStore(join(dir, 'students.json'));
    const teacher = await students.ensureTeacher('sunyumeng');
    const cookie = 'mimi_student=' + await signTicket({ purpose: 'student-login', studentId: teacher.id, expiresAt: Date.now() + 60000 }, 'fixture');
    const fetcher = async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.includes('chat/completions')) {
        modelBodies.push(body);
        await gate;
        return Response.json({ choices: [{ message: { content: JSON.stringify({ narration: ['intro','case1','case2','method'].map(id => ({ id, text: `Explain ${id}.` })) }) } }] });
      }
      return Response.json({ code: 3000, data: Buffer.from('audio fixture').toString('base64') });
    };
    const handler = createShowHandler({ store, students, secret: 'fixture', sources, loadSources: () => sources.current(), settings: async () => defaultSettings(), speech: { appId: 'fixture', token: 'fixture' }, arkKey: 'fixture', fetcher });
    const call = (path, body) => handler(new Request('http://localhost' + path, { method: body ? 'POST' : 'GET', headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }));
    const alpha = { html: '<html><head></head><body>Alpha report</body></html>', prompt: 'Explain Alpha with warmth.' };
    const beta = { html: '<html><head></head><body>Beta report</body></html>', prompt: 'Explain Beta with curiosity.' };
    assert.equal((await call('/api/show/editor', alpha)).status, 200);
    assert.equal((await fileShowSources(options).current()).html, alpha.html);
    assert.equal((await call('/api/show/say', { conversationId: 'alpha', text: 'What did you notice?' })).status, 200);
    assert.equal((await call('/api/show/editor', beta)).status, 200);
    const report = await (await call('/api/show/report?version=1')).text();
    assert.ok(report.includes('Alpha report'));
    assert.ok(report.includes('<base href="/">'));
    const content = await (await call('/api/show/content?version=1')).json();
    assert.equal(content.artifact.url, '/api/show/report?version=1');
    assert.ok(!content.traceResults.join(' ').includes('China–Laos'));
    release();
    const ready = async () => {
      for (let i = 0; i < 200; i++) {
        const state = await store.state();
        if (state.performance?.status === 'ready') return;
        if (state.performance?.status === 'error') assert.fail(state.performance.error);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('Narration did not finish');
    };
    await ready();
    assert.ok(modelBodies[0].messages[0].content.startsWith(alpha.prompt + '\n\n'));
    assert.equal(JSON.parse(modelBodies[0].messages[1].content).report, 'Alpha report');
    await call('/api/show/dismiss', { version: 1 });
    await call('/api/show/say', { conversationId: 'beta', text: 'What did you notice?' });
    await ready();
    assert.ok(modelBodies[1].messages[0].content.startsWith(beta.prompt + '\n\n'));
    assert.equal(JSON.parse(modelBodies[1].messages[1].content).report, 'Beta report');
    assert.ok((await (await call('/api/show/report?version=2')).text()).includes('Beta report'));
    assert.equal((await call('/api/show/editor', { html: '', prompt: 'Instructions' })).status, 400);
    assert.equal((await (await call('/api/show/editor')).json()).html, beta.html);
    assert.ok((await readFile(htmlPath, 'utf8')).includes('Default report'));
  } finally { release(); await rm(dir, { recursive: true, force: true }); }
});
