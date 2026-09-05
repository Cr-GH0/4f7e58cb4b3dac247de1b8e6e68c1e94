import assert from "node:assert/strict";
import test from "node:test";
import { parseGroupMembers, reduceSubtitle, correctSpeaker, speakerLabel, exportTranscript, validateVoiceWav, voiceRegistrationRequest } from "../../hermes-volc-standalone/public/group-session.js";
import { encodeWav } from "../../hermes-volc-standalone/public/voice-enrollment.js";
import { handleRequest } from "../../hermes-volc-standalone/worker.js";
import { testDatabase } from './admin-fixture.mjs';

const members = [1,2,3].map(i => ({ memberId: `speaker_${i}`, name: ["Alice", "Bo", "陈晨"][i-1], voiceprintId: `vp_${i}` }));
const context = { taskId: "session_1", botUserId: "bot", members };
const speech = (roundId, id, text, extra = {}) => ({ roundId, sequence: 0, userId: "shared_pc", voiceprintId: id, voiceprintScore: 70, text, definite: true, paragraph: true, ...extra });

test("three people on the same device remain separate across rounds and sessions", () => {
  let lines = [];
  for (let i = 0; i < 3; i++) lines = reduceSubtitle(lines, speech(i, `vp_${i+1}`, `Statement ${i}`), context);
  lines = reduceSubtitle(lines, speech(0, "vp_2", "Next call"), { ...context, taskId: "session_2" });
  assert.deepEqual(lines.map(l => speakerLabel(l, members)), ["Alice", "Bo", "陈晨", "Bo"]);
  assert.equal(lines.length, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(lines)), lines);
});

test("missing, low, foreign and conflicting identities remain unassigned", () => {
  let lines = reduceSubtitle([], speech(1, "vp_1", "My thought"), context);
  for (const [i, extra] of [{ voiceprintId: "", voiceprintScore: null }, { voiceprintScore: 49 }, { voiceprintId: "outsider" }].entries()) lines = reduceSubtitle(lines, speech(i+2, "vp_1", "Unclear identity", extra), context);
  assert.deepEqual(lines.map(l => l.speakerId), ["speaker_1", null, null, null]);
  lines = reduceSubtitle(lines, speech(5, "vp_1", "First voice", { paragraph: false }), context);
  lines = reduceSubtitle(lines, speech(5, "vp_2", "First voice and second voice", { sequence: 1 }), context);
  assert.equal(lines.at(-1).speakerId, null);
  assert.equal(lines.at(-1).ambiguous, true);
  assert.match(exportTranscript(members, lines, "unknown"), /待确认/);
  assert.doesNotMatch(exportTranscript(members, lines, "speaker_1"), /Unclear identity/);
});

test("interim/final updates do not duplicate records or undo manual corrections", () => {
  let lines = reduceSubtitle([], speech(1, "", "Tea", { paragraph: false }), context);
  const key = lines[0].key;
  lines = correctSpeaker(lines, key, "speaker_3");
  const final = speech(1, "vp_1", "Tea travelled west.", { sequence: 2 });
  lines = reduceSubtitle(lines, final, context);
  lines = reduceSubtitle(lines, final, context);
  lines = reduceSubtitle(lines, speech(1, "vp_1", "Tea", { sequence: 1, paragraph: false }), context);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "Tea travelled west.");
  assert.equal(lines[0].speakerId, "speaker_3");
  assert.equal(lines[0].voiceprintId, "vp_1");
});

test("AI fragments are ordered and the empty final marker closes the reply", () => {
  const ai = (sequence, text, paragraph = false) => ({ userId: "bot", roundId: 1, sequence, text, paragraph, definite: true });
  let lines = reduceSubtitle([], ai(1, "Is that correct?"), context);
  lines = reduceSubtitle(lines, ai(0, "Tea travelled west."), context);
  lines = reduceSubtitle(lines, ai(1, "Is that correct?"), context);
  lines = reduceSubtitle(lines, ai(2, "", true), context);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "Tea travelled west. Is that correct?");
  assert.equal(lines[0].paragraph, true);
});

test("group validation rejects missing or duplicate registrations", () => {
  assert.equal(parseGroupMembers(members).length, 3);
  assert.throws(() => parseGroupMembers(members.slice(0, 2)), /three/);
  assert.throws(() => parseGroupMembers(members.map(m => ({ ...m, voiceprintId: "same" }))), /different/);
});

test("registration sends valid WAV using the separate API version; call enables Mode 2", async () => {
  const bytes = encodeWav(new Float32Array(48000 * 20), 48000);
  assert.equal(validateVoiceWav(bytes), 20);
  assert.throws(() => validateVoiceWav(encodeWav(new Float32Array(16000), 16000)), /15–30/);
  const audio = Buffer.from(bytes).toString("base64");
  assert.equal(voiceRegistrationRequest({ name: "Alice", audio }, "app").Version, 2);
  const env = { VOLC_ACCESS_KEY_ID: "test-access", VOLC_SECRET_ACCESS_KEY: "test-secret", VOLC_RTC_APP_ID: "a".repeat(24), VOLC_RTC_APP_KEY: "test-app-key", DB:testDatabase() };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return Response.json({ Result: String(url).includes("RegisterVoicePrint") ? "vp_registered" : "ok" }); };
  try {
    const register = await handleRequest(new Request("http://localhost/api/voiceprint/register", { method: "POST", body: JSON.stringify({ name: "Alice", audio }) }), env);
    assert.equal((await register.json()).voiceprintId, "vp_registered");
    assert.match(calls[0].url, /Version=2024-12-01/);
    assert.equal(calls[0].body.AudioFormat, 0);
    const response = await handleRequest(new Request("http://localhost/api/voicechat/start", { method: "POST", body: JSON.stringify({ roomId: "room", userId: "shared_pc", botUserId: "bot", taskId: "task", members }) }), env);
    assert.equal(response.status, 200);
    assert.match(calls[1].url, /Version=2025-06-01/);
    assert.deepEqual(calls[1].body.AgentConfig.VoicePrint, { Mode: 2, IdList: ["vp_1", "vp_2", "vp_3"], Score: 50 });
    assert.deepEqual(calls[1].body.AgentConfig.TargetUserId, ["shared_pc"]);
  } finally { globalThis.fetch = originalFetch; }
});
