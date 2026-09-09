// Text compatibility mode for browsers that cannot run the RTC SDK: the
// student types, Mimi replies with the same coach instructions as an RTC call,
// and the answer is synthesized to audio. Shared by Node and Workers.
import { systemMessages, parseContext } from './voice-chat-config.js';
import { currentStudent } from '../student-api.js';

const TTS_URL = 'https://openspeech.bytedance.com/api/v1/tts';
const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
export const TALK_MAX_TEXT = 8000;
// Compatibility replies must survive one non-streamed synthesis pass, so keep
// them even tighter than the coach's standing two-sentence rule.
const TALK_REPLY_RULE = 'You are talking over a phone recording link. Reply with exactly ONE short sentence of at most 20 words. Never write more than one sentence, never use lists, and never ask more than one question.';

export function readSpeechCredentials(env = process.env) {
  const appId = env.VOLC_SPEECH_APP_ID?.trim();
  const token = env.VOLC_SPEECH_ACCESS_TOKEN?.trim();
  return appId && token ? { appId, token } : null;
}
export function readArkKey(env = process.env) {
  return env.ARK_API_KEY?.trim() || null;
}

/** Volcengine caps one synthesis request at 1024 UTF-8 bytes; stay under it. */
export function clampSpeechText(text, limit = 960) {
  const size = value => new TextEncoder().encode(value).length;
  if (size(text) <= limit) return text;
  let out = '';
  for (const part of text.match(/[^.!?。！？]+[.!?。！？]*/g) ?? []) {
    if (!part.trim()) continue;
    if (size(out + part) > limit) {
      if (out) break;
      let bytes = 0, chars = 0;
      for (const ch of part) { const width = size(ch); if (bytes + width > limit) break; bytes += width; chars += ch.length; }
      out = part.slice(0, chars);
      break;
    }
    out += part;
  }
  return out.trim() || text;
}

export async function synthesizeSpeech(text, credentials, settings, fetcher = fetch) {
  const speed = Math.min(3, Math.max(0.2, 1 + (settings.tts.speechRate || 0) / 100));
  const response = await fetcher(TTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer;${credentials.token}` },
    body: JSON.stringify({
      app: { appid: credentials.appId, token: 'access', cluster: 'volcano_tts' },
      user: { uid: 'mimi-compat' },
      audio: { voice_type: settings.tts.speaker, encoding: 'mp3', speed_ratio: speed },
      request: { reqid: crypto.randomUUID(), text: clampSpeechText(text), text_type: 'plain', operation: 'query' },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.code !== 3000 || typeof data?.data !== 'string' || !data.data) {
    throw new Error(`SpeechSynthesisFailed: ${data?.message ?? `HTTP ${response.status}`}`);
  }
  return { audio: data.data, mime: 'audio/mpeg' };
}

export function buildTalkLlmBody({ settings, context, text, purpose = 'conversation' }) {
  const messages = systemMessages(context, settings, purpose);
  const system = purpose === 'conversation' ? [messages[0], TALK_REPLY_RULE, ...messages.slice(1)].join('\n\n') : messages.join('\n\n');
  return {
    model: settings.llm.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: purpose === 'outline' ? 'Organize the personal outline for the current student from the application record. Reply with the outline text only.' : text },
    ],
    temperature: settings.llm.temperature, top_p: settings.llm.topP,
    // One short sentence must also survive a tight token budget so the whole
    // typed → answer turn stays under three seconds.
    max_tokens: Math.min(settings.llm.maxTokens, 160),
    thinking: { type: 'disabled' },
  };
}

export async function completeReply(body, arkKey, fetcher = fetch) {
  const response = await fetcher(ARK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${arkKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const data = await response.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (!response.ok || typeof content !== 'string' || !content.trim()) {
    throw new Error(`ConversationModelFailed: ${data?.error?.message ?? `HTTP ${response.status}`}`);
  }
  return content.trim();
}

export function extractFirstSentence(text) {
  const match = text.match(/^[\s\S]*?[.!?。！？](?=\s|$)/);
  return match ? match[0].trim() : '';
}

/** Parse one SSE data line from the Ark stream; returns the delta or null. */
export function parseStreamDelta(line) {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
    return typeof delta === 'string' ? delta : null;
  } catch { return null; }
}

/**
 * Streams the reply so synthesis of the first sentence starts while the model
 * is still writing. Returns { reply, first }. `first` is the completed first
 * sentence (may equal the whole reply) and can be synthesized immediately.
 */
export async function completeReplyStreaming(body, arkKey, fetcher = fetch) {
  const response = await fetcher(ARK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${arkKey}` },
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    throw new Error(`ConversationModelFailed: ${data?.error?.message ?? `HTTP ${response.status}`}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', reply = '', first = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const delta = parseStreamDelta(line.trim());
      if (!delta) continue;
      reply += delta;
      // Keep consuming this chunk after the first sentence: dropping the rest
      // would lose any complete lines that arrived in the same read.
      if (!first) first = extractFirstSentence(reply);
    }
  }
  reply = reply.trim();
  if (!reply) throw new Error('ConversationModelFailed: empty reply.');
  return { reply, first: first || reply, finished: true };
}

/** Drain the remaining stream after the first sentence has been handed off. */
export async function drainReply(stream) {
  let { reply, buffer } = stream;
  const { reader, decoder } = stream;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const delta = parseStreamDelta(line.trim());
      if (delta) reply += delta;
    }
  }
  return reply.trim();
}

function readableTalkError(message) {
  if (/not configured/i.test(message)) return message;
  if (/ConversationModelFailed/.test(message)) return 'Mimi could not think of a reply just now. Try again in a moment.';
  return 'Compatibility mode is unavailable right now. Try again in a moment.';
}

// Behind a reverse proxy the browser's Origin is the public https domain
// while the request URL may be rebuilt from internal Host values. Compare
// hosts, accepting every host identity the proxy chain provides — the same
// rule the student/admin/show endpoints use.
const TALK_PLATFORM_SUFFIX = '.app.workbuddy.link';
const talkOriginAllowed = (request, url) => {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  let originHost = '';
  try { originHost = new URL(origin).host.toLowerCase(); } catch { return false; }
  if (originHost.endsWith(TALK_PLATFORM_SUFFIX)) return true;
  const hosts = new Set();
  for (const value of [url.host, request.headers.get('Host'), request.headers.get('X-Forwarded-Host')]) {
    for (const piece of String(value ?? '').toLowerCase().split(',')) {
      const host = piece.trim();
      if (host) hosts.add(host);
    }
  }
  return hosts.has(originHost);
};

/**
 * POST /api/talk — one text-mode turn for the signed-in student.
 * Body: {text?: string, context: application record JSON, purpose?}
 */
export async function talkRequest(request, { store, secret, settings, speech, arkKey, fetcher = fetch }) {
  const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  try {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    const url = new URL(request.url);
    if (!talkOriginAllowed(request, url)) return json({ error: 'Open Mimi directly to continue.' }, 403);
    const student = await currentStudent(request, store, secret);
    if (!student) return json({ error: 'Sign in to your Mimi account first.' }, 401);
    const input = await request.json().catch(() => ({}));
    let purpose, context, text;
    try {
      purpose = input?.purpose === 'outline' ? 'outline' : 'conversation';
      context = parseContext(input?.context);
      text = typeof input?.text === 'string' ? input.text.trim().slice(0, TALK_MAX_TEXT) : '';
    } catch (error) { return json({ error: error instanceof Error ? error.message : 'Invalid request.' }, 400); }
    if (!text && purpose !== 'outline') return json({ error: 'Type something first.' }, 400);
    if (!arkKey) return json({ error: 'Text mode is not configured on this server. An administrator must add ARK_API_KEY.' }, 503);
    const body = buildTalkLlmBody({ settings, context, text, purpose });
    let reply, replyAudio = null, replyAudio2 = null, mime = null;
    if (purpose === 'conversation' && speech) {
      // Stream the model and start synthesizing the first sentence while the
      // rest is still being written; play first, synthesize the tail next.
      let stream = null;
      try { stream = await completeReplyStreaming(body, arkKey, fetcher); }
      catch { stream = null; }
      if (stream) {
        const firstSpeech = synthesizeSpeech(stream.first, speech, settings, fetcher).catch(() => null);
        let rest = '';
        if (stream.finished) {
          reply = stream.reply;
          rest = reply.startsWith(stream.first) ? reply.slice(stream.first.length).trim() : '';
        } else {
          reply = await drainReply(stream);
          rest = reply.startsWith(stream.first) ? reply.slice(stream.first.length).trim() : '';
        }
        const restSpeech = rest ? synthesizeSpeech(rest, speech, settings, fetcher).catch(() => null) : null;
        const first = await firstSpeech;
        const second = restSpeech ? await restSpeech : null;
        if (first) ({ audio: replyAudio, mime } = first);
        if (second) replyAudio2 = second.audio;
      } else {
        // Non-streaming fallback for models without stream support.
        reply = await completeReply(body, arkKey, fetcher);
        try { ({ audio: replyAudio, mime } = await synthesizeSpeech(reply, speech, settings, fetcher)); } catch { replyAudio = null; }
      }
    } else {
      reply = await completeReply(body, arkKey, fetcher);
    }
    return json({ studentText: text, replyText: reply, audio: replyAudio, audio2: replyAudio2, mime, purpose });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error.';
    console.error('[talk]', message);
    return json({ error: readableTalkError(message) }, 502);
  }
}
