// Local end-to-end probe for the text-chat architecture and classroom show.
// Usage: node probe-show.mjs [baseUrl]   (expects the server's .env.local next to this file)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(here, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2];
}
const BASE = process.argv[2] || `http://localhost:${process.env.PORT || 3210}`;
const password = process.env.HERMES_ADMIN_PASSWORD || env.HERMES_ADMIN_PASSWORD;
const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, detail]); if (!ok) process.exitCode = 1; };
const jar = {};
async function call(method, path, { body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const key = cookie ?? 'student';
  if (jar[key]) headers.Cookie = jar[key];
  const response = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie && key) jar[key] = setCookie.split(';')[0];
  return response;
}

// 1. pages and config
{
  const page = await fetch(BASE + '/');
  check('GET /', page.status === 200, String(page.status));
  const config = await (await fetch(BASE + '/api/config')).json();
  check('GET /api/config', Number.isInteger(config.autoSendPauseMs) && config.autoSendPauseMs >= 300, JSON.stringify(config));
  const old = await fetch(BASE + '/api/voiceprint/register', { method: 'POST' });
  check('voiceprint route removed', old.status === 404 || old.status === 405, String(old.status));
}
// 2. student register + role
{
  const response = await call('POST', '/api/student/register', { body: { name: 'Probe Student' }, cookie: 'student' });
  const data = await response.json();
  check('register by name only', response.status === 200 && /^[1-9][0-9]{3}$/.test(data.account?.accountName ?? '') && data.account?.role === 'student', JSON.stringify(data.account ?? data));
  const status = await (await call('GET', '/api/student/status', { cookie: 'student' })).json();
  check('student status signed in', status.account?.role === 'student', JSON.stringify(status.account ?? status));
}
// 3. teacher login by name
{
  await call('POST', '/api/student/logout', { body: {}, cookie: 'teacher' });
  const response = await call('POST', '/api/student/login', { body: { code: 'sunyumeng' }, cookie: 'teacher' });
  const data = await response.json();
  check('teacher login by name', response.status === 200 && data.account?.role === 'teacher' && data.account?.accountName === 'sunyumeng', JSON.stringify(data.account ?? data));
  const stranger = await call('POST', '/api/student/login', { body: { code: 'notateacher' }, cookie: 'stranger' });
  check('unknown name rejected', stranger.status === 400, String(stranger.status));
}
// 4. show trigger rules
{
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const before = await (await call('GET', '/api/show/state', { cookie: 'teacher' })).json();
  check('state reachable', Number.isInteger(before.version) && before.active === false, JSON.stringify(before));
  const studentSay = await call('POST', '/api/show/say', { body: { conversationId: 'probe1', text: 'mimi，请总结一下大家的练习' }, cookie: 'student' });
  check('student cannot trigger', studentSay.status === 401, String(studentSay.status));
  await delay(3200); // the heartbeat from the state poll must expire before the offline check
  const offline = await (await call('POST', '/api/show/say', { body: { conversationId: 'probe1', text: 'mimi，请总结一下大家的练习' }, cookie: 'teacher' })).json();
  check('desktop offline blocks trigger', offline.reply?.includes('桌面端未连接'), JSON.stringify(offline));
  await call('GET', '/api/show/state', { cookie: 'teacher' }); // heartbeat
  const first = await (await call('POST', '/api/show/say', { body: { conversationId: 'probe1', text: 'mimi，请总结一下大家的练习' }, cookie: 'teacher' })).json();
  check('first message triggers', first.reply?.includes('正在整理报告') && first.version === before.version + 1, JSON.stringify(first));
  const again = await (await call('POST', '/api/show/say', { body: { conversationId: 'probe1', text: '再来一句' }, cookie: 'teacher' })).json();
  check('same session only once', again.reply?.includes('本场已完成'), JSON.stringify(again));
  const state = await (await call('GET', '/api/show/state', { cookie: 'teacher' })).json();
  check('state shows active', state.active === true && state.triggerText.includes('总结'), JSON.stringify(state));
  check('audio not generated yet', state.audioReady === false, String(state.audioReady));
}
// 5. content and progress
{
  const content = await (await call('GET', '/api/show/content', { cookie: 'teacher' })).json();
  check('content served', content.report?.cases?.length === 2 && Array.isArray(content.narration) && content.narration.length >= 1, `cases=${content.report?.cases?.length} narration=${content.narration?.length}`);
  const state = await (await call('GET', '/api/show/state', { cookie: 'teacher' })).json();
  const progress = await call('POST', '/api/show/progress', { body: { version: state.version, segment: 1 }, cookie: 'teacher' });
  check('progress accepted', progress.status === 200, String(progress.status));
  const after = await (await call('GET', '/api/show/state', { cookie: 'teacher' })).json();
  check('progress persisted', after.lastSegment === 1, String(after.lastSegment));
  const anon = await fetch(BASE + '/api/show/content');
  check('content needs teacher', anon.status === 401, String(anon.status));
}
// 6. admin synthesizes the show audio (real TTS calls)
{
  const login = await call('POST', '/api/admin/login', { body: { password }, cookie: 'admin' });
  check('admin login', login.status === 200, String(login.status));
  const synth = await call('POST', '/api/admin/show-audio', { body: {}, cookie: 'admin' });
  const data = await synth.json();
  check('show audio synthesized', synth.status === 200 && data.ok === true && data.segments.length >= 5, JSON.stringify(data).slice(0, 160));
  const ack = await fetch(`${BASE}/api/show/audio/ack`, { headers: { Cookie: jar.teacher } });
  const bytes = ack.status === 200 ? (await ack.arrayBuffer()).byteLength : 0;
  check('ack audio streams to teacher', ack.status === 200 && (ack.headers.get('content-type') || '').includes('audio/mpeg') && bytes > 1000, `${ack.status} ${bytes}B`);
  const narration = await fetch(`${BASE}/api/show/audio/intro`, { headers: { Cookie: jar.teacher } });
  check('narration audio streams', narration.status === 200 && (await narration.arrayBuffer()).byteLength > 1000, String(narration.status));
  const bogus = await fetch(`${BASE}/api/show/audio/nope`, { headers: { Cookie: jar.teacher } });
  check('unknown audio 404', bogus.status === 404, String(bogus.status));
  const state = await (await call('GET', '/api/show/state', { cookie: 'teacher' })).json();
  check('audioReady now true', state.audioReady === true, String(state.audioReady));
}
// 7. student room start + text reply (real Volcano calls)
{
  const session = await (await call('POST', '/api/session', { body: {}, cookie: 'student' })).json();
  check('session issued', session.roomId && session.rtcToken, session.roomId ?? 'missing');
  const teacherStart = await call('POST', '/api/voicechat/start', { body: { ...session, context: '{}' }, cookie: 'teacher' });
  check('teacher cannot start room', teacherStart.status === 502, String(teacherStart.status));
  const start = await call('POST', '/api/voicechat/start', { body: { ...session, context: '{}' }, cookie: 'student' });
  const startBody = await start.json();
  check('student starts chat room', start.status === 200 && startBody.ok === true, JSON.stringify(startBody).slice(0, 120));
  const update = await call('POST', '/api/voicechat/update', { body: { ...session, configTicket: startBody.configTicket, configRevision: startBody.configRevision, action: 'respond', purpose: 'conversation', context: '{}', text: JSON.stringify({ currentPersonId: 'p1', request: 'Reply to the current student.', studentText: 'Hello Mimi, my case is Chinese tea reaching Europe.' }) }, cookie: 'student' });
  check('text injection accepted', update.status === 200, String(update.status));
  await call('POST', '/api/voicechat/stop', { body: session, cookie: 'student' });
  const talk = await call('POST', '/api/talk', { body: { text: 'Hello Mimi, this is a probe message.', context: '{}' }, cookie: 'student' });
  const talkBody = await talk.json();
  check('talk fallback replies with audio', talk.status === 200 && typeof talkBody.replyText === 'string' && talkBody.replyText.length > 0 && typeof talkBody.audio === 'string', JSON.stringify(talkBody).slice(0, 120));
}
// 8. anti-forgery
{
  const cross = await fetch(`${BASE}/api/show/say`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com', Cookie: jar.teacher }, body: JSON.stringify({ conversationId: 'probe9', text: 'x' }) });
  check('cross-site trigger rejected', cross.status === 403, String(cross.status));
}

const width = Math.max(...results.map(([, name]) => name.length));
for (const [status, name, detail] of results) console.log(`${status}  ${name.padEnd(width)}  ${detail}`);
console.log(`\n${results.filter(r => r[0] === 'PASS').length}/${results.length} checks passed against ${BASE}`);
