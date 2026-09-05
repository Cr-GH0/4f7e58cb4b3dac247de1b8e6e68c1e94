import { d1SettingsStore } from './admin-store.js';
import { adminRequest } from './admin-api.js';
import { startSettings, callSettings } from './admin-security.js';
// Hermes Voice Coach — Cloudflare Worker entry (deployable, stable URL).
// Same logic as server.mjs but uses the Web Crypto API (global `crypto`)
// so it runs unchanged on Cloudflare Workers AND on Node 22 (for local tests).
// Static assets are served via the ASSETS binding (wrangler.toml).

import { voiceRegistrationRequest } from "./public/group-session.js";
import { buildHermesVoiceChatRequest, buildVoiceUpdates } from "./public/voice-chat-config.js";

const RTC_API_HOST = "rtc.volcengineapi.com";
const RTC_API_VERSION = "2025-06-01";
const REGION = "cn-north-1";
const SERVICE = "rtc";

// ---- tiny byte helpers (no Node Buffer, no deps) ----
const enc = (s) => new TextEncoder().encode(s);
function toHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
async function sha256HexBytes(data) {
  const h = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(h));
}
async function hmacBytes(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes);
  return new Uint8Array(sig);
}

// ---------------------------------------------------------------------------
// Volcengine OpenAPI V4 signing (mirrors @volcengine/openapi Signer)
// ---------------------------------------------------------------------------
async function signVolcengine({ action, bodyStr }, credentials) {
  const apiVersion = action === "RegisterVoicePrint" ? "2024-12-01" : RTC_API_VERSION;
  const xDate = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[:\-]/g, "");
  const date8 = xDate.slice(0, 8);
  const bodyHash = await sha256HexBytes(enc(bodyStr));

  const headerValues = {
    host: RTC_API_HOST,
    "x-content-sha256": bodyHash,
    "x-date": xDate,
  };
  const signedHeaderKeys = ["host", "x-content-sha256", "x-date"];
  const canonicalHeaders = signedHeaderKeys
    .map((k) => `${k}:${headerValues[k]}`)
    .join("\n");
  const signedHeaders = signedHeaderKeys.join(";");
  const queryString = `Action=${action}&Version=${apiVersion}`;

  const canonicalRequest = [
    "POST",
    "/",
    queryString,
    canonicalHeaders + "\n",
    signedHeaders,
    bodyHash,
  ].join("\n");

  const scope = `${date8}/${REGION}/${SERVICE}/request`;
  const stringToSign = [
    "HMAC-SHA256",
    xDate,
    scope,
    await sha256HexBytes(enc(canonicalRequest)),
  ].join("\n");

  const secretBytes = enc(credentials.secretKey);
  const kDate = await hmacBytes(secretBytes, enc(date8));
  const kRegion = await hmacBytes(kDate, enc(REGION));
  const kService = await hmacBytes(kRegion, enc(SERVICE));
  const signingKey = await hmacBytes(kService, enc("request"));
  const signature = toHex(await hmacBytes(signingKey, enc(stringToSign)));

  const authorization = `HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `https://${RTC_API_HOST}/?Action=${action}&Version=${apiVersion}`,
    headers: {
      Host: RTC_API_HOST,
      "Content-Type": "application/json",
      "X-Date": xDate,
      "X-Content-Sha256": bodyHash,
      Authorization: authorization,
    },
  };
}

async function callRtcOpenApi(action, body, credentials) {
  const bodyStr = JSON.stringify(body);
  const { url, headers } = await signVolcengine({ action, bodyStr }, credentials);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), action === "RegisterVoicePrint" ? 25_000 : 12_000);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => ({}));
  const apiError = payload?.ResponseMetadata?.Error;
  if (!response.ok || apiError) {
    const code = apiError?.Code ?? `HTTP_${response.status}`;
    const message = apiError?.Message ?? "Volcengine request failed.";
    throw new Error(`${code}: ${message}`);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// RTC token generation (HMAC-SHA256 with AppKey, byte-exact with server.mjs)
// ---------------------------------------------------------------------------
const TOKEN_VERSION = "001";
const RTC_PRIVILEGES = {
  publishStream: 0,
  publishAudioStream: 1,
  publishVideoStream: 2,
  publishDataStream: 3,
  subscribeStream: 4,
};
class ByteBuffer {
  constructor() {
    this.chunks = [];
  }
  putUint16(v) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    this.chunks.push(b);
    return this;
  }
  putUint32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.chunks.push(b);
    return this;
  }
  putBytes(value) {
    if (value.length > 0xffff) throw new Error("RTC token field too long.");
    this.putUint16(value.length);
    this.chunks.push(value);
    return this;
  }
  putString(v) {
    return this.putBytes(enc(v));
  }
  putPrivilegeMap(privileges) {
    const entries = Object.entries(privileges).sort(
      ([a], [b]) => Number(a) - Number(b),
    );
    this.putUint16(entries.length);
    for (const [priv, expiresAt] of entries) {
      this.putUint16(Number(priv));
      this.putUint32(expiresAt);
    }
    return this;
  }
  pack() {
    const len = this.chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}
async function generateRtcToken({ appId, appKey, roomId, userId, expiresAt }) {
  if (appId.length !== 24) throw new Error("VOLC_RTC_APP_ID must be 24 chars.");
  const issuedAt = Math.floor(Date.now() / 1000);
  const nonce = crypto.getRandomValues(new Uint8Array(4));
  const nonce32 = new DataView(nonce.buffer).getUint32(0, true);
  const privileges = {
    [RTC_PRIVILEGES.publishStream]: 0,
    [RTC_PRIVILEGES.publishAudioStream]: 0,
    [RTC_PRIVILEGES.publishVideoStream]: 0,
    [RTC_PRIVILEGES.publishDataStream]: 0,
    [RTC_PRIVILEGES.subscribeStream]: 0,
  };
  const message = new ByteBuffer()
    .putUint32(nonce32)
    .putUint32(issuedAt)
    .putUint32(expiresAt)
    .putString(roomId)
    .putString(userId)
    .putPrivilegeMap(privileges)
    .pack();
  const signature = await hmacBytes(enc(appKey), message);
  const content = new ByteBuffer().putBytes(message).putBytes(signature).pack();
  return `${TOKEN_VERSION}${appId}${btoa(String.fromCharCode(...content))}`;
}

// ---------------------------------------------------------------------------
// Hermes agent request body (from lib/hermes-config.ts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------
const RTC_ID_PATTERN = /^[A-Za-z0-9_@.-]{1,128}$/;
function parseIdentifiers(body) {
  const record = body || {};
  const fields = ["roomId", "userId", "botUserId", "taskId"];
  const out = {};
  for (const f of fields) {
    const v = record[f];
    if (typeof v !== "string" || !RTC_ID_PATTERN.test(v)) throw new Error(`Invalid ${f}.`);
    out[f] = v;
  }
  return out;
}
function safeApiError(err) {
  const msg = err instanceof Error ? err.message : "Unknown error.";
  if (/^(Server configuration missing|Invalid |[A-Za-z0-9_.-]+: )/.test(msg)) return msg;
  return "The voice service could not complete the request.";
}
function getCredentials(env) {
  const accessKeyId = (env.VOLC_ACCESS_KEY_ID || env.VOLC_ACCESS_KEY)?.trim();
  const secretKey = (env.VOLC_SECRET_ACCESS_KEY || env.VOLC_SECRET_KEY)?.trim();
  const appId = env.VOLC_RTC_APP_ID?.trim();
  const appKey = env.VOLC_RTC_APP_KEY?.trim();
  if (!accessKeyId || !secretKey || !appId || !appKey) {
    throw new Error("Server configuration missing VOLC_* credentials.");
  }
  return { accessKeyId, secretKey, appId, appKey };
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.startsWith('/api/admin/')) return adminRequest(request, d1SettingsStore(env.DB), env.HERMES_ADMIN_PASSWORD, {
    accessKeyId: env.VOLC_ACCESS_KEY_ID?.trim(), secretKey: env.VOLC_SECRET_ACCESS_KEY?.trim(),
  });
  const credentials = getCredentials(env);

  if (request.method === "POST" && path === "/api/session") {
    const suffix = (crypto.randomUUID?.() ?? crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")).replaceAll("-", "");
    const roomId = `hermes_${suffix}`;
    const userId = `student_${suffix}`;
    const botUserId = `hermes_ai_${suffix}`;
    const taskId = `task_${suffix}`;
    const expiresAt = Math.floor(Date.now() / 1000) + 12 * 60;
    const rtcToken = await generateRtcToken({
      appId: credentials.appId,
      appKey: credentials.appKey,
      roomId,
      userId,
      expiresAt,
    });
    return Response.json({
      appId: credentials.appId,
      roomId,
      userId,
      botUserId,
      taskId,
      rtcToken,
      expiresAt,
    });
  }

  if (request.method === "POST" && path === "/api/voicechat/start") {
    const input = await request.json();
    const ids = parseIdentifiers(input);
    const configuration = await startSettings(ids, d1SettingsStore(env.DB), credentials.appKey);

    await callRtcOpenApi(
      "StartVoiceChat",
      buildHermesVoiceChatRequest({
        appId: credentials.appId,
        roomId: ids.roomId,
        taskId: ids.taskId,
        studentUserId: ids.userId,
        agentUserId: ids.botUserId,
        members: input.members, mode: input.mode, context: input.context,
      }, configuration.settings),
      credentials,
    );
    return Response.json({ ok: true, ...configuration.result });
  }

  if (request.method === "POST" && path === "/api/voicechat/update") {
    const input = await request.json();
    const ids = parseIdentifiers(input);
    const settings = input.action === 'interrupt' ? undefined : await callSettings(input, ids, d1SettingsStore(env.DB), credentials.appKey);
    for (const body of buildVoiceUpdates(input, credentials.appId, ids, settings)) await callRtcOpenApi("UpdateVoiceChat", body, credentials);
    return Response.json({ ok: true });
  }

  if (request.method === "POST" && path === "/api/voiceprint/register") {
    const body = voiceRegistrationRequest(await request.json(), credentials.appId);
    const result = await callRtcOpenApi("RegisterVoicePrint", body, credentials);
    if (typeof result.Result !== "string" || !result.Result) throw new Error("RegistrationFailed: No voiceprint ID returned.");
    return Response.json({ voiceprintId: result.Result });
  }

  if (request.method === "POST" && path === "/api/voicechat/stop") {
    const ids = parseIdentifiers(await request.json().catch(() => ({})));
    await callRtcOpenApi(
      "StopVoiceChat",
      { AppId: credentials.appId, RoomId: ids.roomId, TaskId: ids.taskId },
      credentials,
    );
    return Response.json({ ok: true });
  }

  // static assets
  if (env.ASSETS) return env.ASSETS.fetch(path === '/admin' || path === '/admin/' ? new Request(new URL('/admin.html', request.url), request) : request);
  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error.";
      console.error("[api error]", msg);
      return Response.json({ error: safeApiError(err) }, { status: 502 });
    }
  },
};
