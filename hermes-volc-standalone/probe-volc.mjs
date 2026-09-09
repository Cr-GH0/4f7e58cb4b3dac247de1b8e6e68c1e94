// Probe: call Volcano StartVoiceChat directly (enrollment mode = no voiceprint needed),
// then StopVoiceChat. Reports the exact API response/error.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHermesVoiceChatRequest } from './public/voice-chat-config.js';

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const CFG = {
  accessKeyId: process.env.VOLC_ACCESS_KEY_ID?.trim(),
  secretKey: process.env.VOLC_SECRET_ACCESS_KEY?.trim(),
  appId: process.env.VOLC_RTC_APP_ID?.trim(),
  appKey: process.env.VOLC_RTC_APP_KEY?.trim(),
};
for (const [k, v] of Object.entries(CFG)) if (!v) { console.error('Missing credential', k); process.exit(1); }

const RTC_API_HOST = 'rtc.volcengineapi.com';
const RTC_API_VERSION = "2025-06-01";
const REGION = 'cn-north-1';
const SERVICE = 'rtc';
const sha256Hex = s => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, msg) => createHmac('sha256', key).update(msg, 'utf8').digest();

function signVolcengine({ action, bodyStr }) {
  const HEADER_VALUES = {
    host: RTC_API_HOST,
    'x-content-sha256': sha256Hex(bodyStr),
    'x-date': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:\-]/g, ''),
  };
  const datetime = HEADER_VALUES['x-date'];
  const date8 = datetime.slice(0, 8);
  const signedHeaderKeys = ['host', 'x-content-sha256', 'x-date'];
  const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${HEADER_VALUES[k]}`).join('\n');
  const signedHeaders = signedHeaderKeys.join(';');
  const canonicalRequest = ['POST', '/', `Action=${action}&Version=${RTC_API_VERSION}`, canonicalHeaders + '\n', signedHeaders, HEADER_VALUES['x-content-sha256']].join('\n');
  const scope = `${date8}/${REGION}/${SERVICE}/request`;
  const stringToSign = ['HMAC-SHA256', datetime, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(CFG.secretKey, date8);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const url = `https://${RTC_API_HOST}/?Action=${action}&Version=${RTC_API_VERSION}`;
  return { url, headers: { host: RTC_API_HOST, 'x-content-sha256': HEADER_VALUES['x-content-sha256'], 'x-date': datetime, Authorization: `HMAC-SHA256 Credential=${CFG.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, 'Content-Type': 'application/json' } };
}

async function call(action, body) {
  const bodyStr = JSON.stringify(body);
  const { url, headers } = signVolcengine({ action, bodyStr });
  const response = await fetch(url, { method: 'POST', headers, body: bodyStr });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

const ids = {
  appId: CFG.appId,
  roomId: 'probe_room_0908',
  taskId: 'probe_task_0908',
  studentUserId: 'probe_student_0908',
  agentUserId: 'probe_agent_0908',
};
const request = buildHermesVoiceChatRequest({ ...ids, mode: 'enrollment', members: [], context: '{}' });

console.log('--- StartVoiceChat (enrollment probe) ---');
const start = await call('StartVoiceChat', request);
console.log('HTTP', start.status);
console.log(JSON.stringify(start.payload, null, 2).slice(0, 1200));

if (!start.payload?.ResponseMetadata?.Error) {
  await new Promise(r => setTimeout(r, 2000));
  console.log('--- StopVoiceChat (cleanup) ---');
  const stop = await call('StopVoiceChat', { AppId: CFG.appId, RoomId: ids.roomId, TaskId: ids.taskId });
  console.log('HTTP', stop.status);
  console.log(JSON.stringify(stop.payload, null, 2).slice(0, 600));
}
