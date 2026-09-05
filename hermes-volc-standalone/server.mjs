// Hermes Voice Coach — standalone Volcengine-connected server.
// Reuses the team's exact config from hermes-voice-coach:
//   - RTC token generation (HMAC-SHA256 with AppKey)
//   - Volcengine OpenAPI V4 signing (HMAC-SHA256, rtc service)
//   - Hermes agent request body (doubao model + TTS voice + system prompt)
// No framework, no extra deps — runs on Node 22+.

import { createServer } from "node:http";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { voiceRegistrationRequest } from "./public/group-session.js";
import { buildHermesVoiceChatRequest, buildVoiceUpdates } from "./public/voice-chat-config.js";
import { fileSettingsStore } from './admin-store-node.js';
import { adminRequest } from './admin-api.js';
import { startSettings, callSettings } from './admin-security.js';

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const settingsStore = fileSettingsStore(join(__dirname, '.hermes-settings.json'));

// ---------------------------------------------------------------------------
// 1. Load Volcengine credentials from .env.local (single source of truth)
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = join(__dirname, ".env.local");
  if (!existsSync(envPath)) {
    throw new Error("Missing .env.local next to server.mjs (VOLC_* credentials).");
  }
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

const CFG = {
  accessKeyId: process.env.VOLC_ACCESS_KEY_ID?.trim(),
  secretKey: process.env.VOLC_SECRET_ACCESS_KEY?.trim(),
  appId: process.env.VOLC_RTC_APP_ID?.trim(),
  appKey: process.env.VOLC_RTC_APP_KEY?.trim(),
};
for (const [k, v] of Object.entries(CFG)) {
  if (!v) throw new Error(`Missing credential ${k} in .env.local`);
}

// ---------------------------------------------------------------------------
// 2. Volcengine OpenAPI V4 signing (mirrors @volcengine/openapi Signer)
// ---------------------------------------------------------------------------
const RTC_API_HOST = "rtc.volcengineapi.com";
const RTC_API_VERSION = "2025-06-01";
const REGION = "cn-north-1";
const SERVICE = "rtc";

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}
function hmac(key, msg) {
  return createHmac("sha256", key).update(msg, "utf8").digest();
}

function signVolcengine({ action, bodyStr }) {
  const apiVersion = action === "RegisterVoicePrint" ? "2024-12-01" : RTC_API_VERSION;
  const HEADER_VALUES = {
    host: RTC_API_HOST,
    "x-content-sha256": sha256Hex(bodyStr),
    "x-date": new Date()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z")
      .replace(/[:\-]/g, ""), // YYYYMMDDTHHMMSSZ
  };
  const datetime = HEADER_VALUES["x-date"];
  const date8 = datetime.slice(0, 8);
  const bodyHash = HEADER_VALUES["x-content-sha256"];

  const queryString = `Action=${action}&Version=${apiVersion}`;
  // Signable headers (content-type is intentionally NOT signed per Volcengine spec)
  const signedHeaderKeys = ["host", "x-content-sha256", "x-date"];
  const canonicalHeaders = signedHeaderKeys
    .map((k) => `${k}:${HEADER_VALUES[k]}`)
    .join("\n");
  const signedHeaders = signedHeaderKeys.join(";");

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
    datetime,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(CFG.secretKey, date8);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const signingKey = hmac(kService, "request");
  const signature = hmac(signingKey, stringToSign).toString("hex");

  const authorization = `HMAC-SHA256 Credential=${CFG.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `https://${RTC_API_HOST}/?Action=${action}&Version=${apiVersion}`,
    headers: {
      Host: RTC_API_HOST,
      "Content-Type": "application/json",
      "X-Date": datetime,
      "X-Content-Sha256": bodyHash,
      Authorization: authorization,
    },
  };
}

async function callRtcOpenApi(action, body) {
  const bodyStr = JSON.stringify(body);
  const { url, headers } = signVolcengine({ action, bodyStr });
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
// 3. RTC token generation (HMAC-SHA256 with AppKey)
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
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16LE(v, 0);
    this.chunks.push(b);
    return this;
  }
  putUint32(v) {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(v >>> 0, 0);
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
    return this.putBytes(Buffer.from(v, "utf8"));
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
    return Buffer.concat(this.chunks);
  }
}

function generateRtcToken({ appId, appKey, roomId, userId, expiresAt }) {
  if (appId.length !== 24) throw new Error("VOLC_RTC_APP_ID must be 24 chars.");
  const issuedAt = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(4).readUInt32LE(0);
  const privileges = {
    [RTC_PRIVILEGES.publishStream]: 0,
    [RTC_PRIVILEGES.publishAudioStream]: 0,
    [RTC_PRIVILEGES.publishVideoStream]: 0,
    [RTC_PRIVILEGES.publishDataStream]: 0,
    [RTC_PRIVILEGES.subscribeStream]: 0,
  };
  const message = new ByteBuffer()
    .putUint32(nonce)
    .putUint32(issuedAt)
    .putUint32(expiresAt)
    .putString(roomId)
    .putString(userId)
    .putPrivilegeMap(privileges)
    .pack();
  const signature = createHmac("sha256", appKey).update(message).digest();
  const content = new ByteBuffer()
    .putBytes(message)
    .putBytes(signature)
    .pack()
    .toString("base64");
  return `${TOKEN_VERSION}${appId}${content}`;
}

// ---------------------------------------------------------------------------
// 4. Hermes agent request body (from lib/hermes-config.ts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5. HTTP server: APIs + static files
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

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (urlPath === "/") urlPath = "/index.html";
  if (urlPath === "/admin" || urlPath === "/admin/") urlPath = "/admin.html";
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    res.writeHead(404).end("Not found");
    return;
  }
  const data = await readFile(filePath);
  res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
  res.end(data);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (path.startsWith('/api/admin/')) {
      const body = ['GET','HEAD'].includes(req.method) ? undefined : JSON.stringify(await readJsonBody(req));
      const request = new Request(new URL(req.url, `http://${req.headers.host}`), { method:req.method, headers:req.headers, body });
      const response = await adminRequest(request, settingsStore, process.env.HERMES_ADMIN_PASSWORD, CFG);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
      return;
    }

    if (req.method === "POST" && path === "/api/session") {
      const suffix = randomUUID().replaceAll("-", "");
      const roomId = `hermes_${suffix}`;
      const userId = `student_${suffix}`;
      const botUserId = `hermes_ai_${suffix}`;
      const taskId = `task_${suffix}`;
      const expiresAt = Math.floor(Date.now() / 1000) + 12 * 60;
      const rtcToken = generateRtcToken({
        appId: CFG.appId,
        appKey: CFG.appKey,
        roomId,
        userId,
        expiresAt,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ appId: CFG.appId, roomId, userId, botUserId, taskId, rtcToken, expiresAt }),
      );
      return;
    }

    if (req.method === "POST" && path === "/api/voicechat/start") {
      const input = await readJsonBody(req);
      const ids = parseIdentifiers(input);
      const configuration = await startSettings(ids, settingsStore, CFG.appKey);

      await callRtcOpenApi(
        "StartVoiceChat",
        buildHermesVoiceChatRequest({
          appId: CFG.appId,
          roomId: ids.roomId,
          taskId: ids.taskId,
          studentUserId: ids.userId,
          agentUserId: ids.botUserId,
          members: input.members, mode: input.mode, context: input.context,
        }, configuration.settings),
      );
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, ...configuration.result }));
      return;
    }

    if (req.method === "POST" && path === "/api/voicechat/update") {
      const input = await readJsonBody(req);
      const ids = parseIdentifiers(input);
      const settings = input.action === 'interrupt' ? undefined : await callSettings(input, ids, settingsStore, CFG.appKey);
      for (const body of buildVoiceUpdates(input, CFG.appId, ids, settings)) await callRtcOpenApi("UpdateVoiceChat", body);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && path === "/api/voiceprint/register") {
      const body = voiceRegistrationRequest(await readJsonBody(req), CFG.appId);
      const result = await callRtcOpenApi("RegisterVoicePrint", body);
      if (typeof result.Result !== "string" || !result.Result) throw new Error("RegistrationFailed: No voiceprint ID returned.");
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ voiceprintId: result.Result }));
      return;
    }

    if (req.method === "POST" && path === "/api/voicechat/stop") {
      const ids = parseIdentifiers(await readJsonBody(req));
      await callRtcOpenApi("StopVoiceChat", {
        AppId: CFG.appId,
        RoomId: ids.roomId,
        TaskId: ids.taskId,
      });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    res.writeHead(405).end("Method not allowed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error.";
    console.error("[api error]", msg);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: safeApiError(err) }));
  }
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  console.log(`Hermes Volcengine voice coach running on http://localhost:${PORT}`);
});
