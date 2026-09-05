import assert from "node:assert/strict";
import test from "node:test";
import {
  inferOutlineStep,
  parseFourPartOutline,
  parseTlvMessage,
} from "../lib/voice-protocol.ts";

function makeTlv(type: string, payload: unknown) {
  const typeBytes = new TextEncoder().encode(type.padEnd(4, "\0").slice(0, 4));
  const valueBytes = new TextEncoder().encode(JSON.stringify(payload));
  const buffer = new ArrayBuffer(8 + valueBytes.length);
  const bytes = new Uint8Array(buffer);
  bytes.set(typeBytes, 0);
  new DataView(buffer).setUint32(4, valueBytes.length, false);
  bytes.set(valueBytes, 8);
  return buffer;
}

test("parses Volcengine TLV status and subtitle messages", () => {
  assert.deepEqual(parseTlvMessage(makeTlv("conv", { Stage: { Code: 2 } })), {
    type: "conv",
    payload: { Stage: { Code: 2 } },
  });
  assert.deepEqual(
    parseTlvMessage(
      makeTlv("subv", {
        data: [{ text: "My case is tea.", definite: true, userId: "student" }],
      }),
    ).type,
    "subv",
  );
});

test("extracts the four confirmed parts in the required order", () => {
  const text =
    "Here is your four-part outline. One, case facts. Tea travelled west. " +
    "Two, exchange and change. Tea culture was adapted locally. " +
    "Three, principle and reason. Diversity, because traditions developed differently. " +
    "Four, youth attitude or action. Listen respectfully and join dialogue. " +
    "Does this accurately represent your ideas?";

  assert.deepEqual(parseFourPartOutline(text), [
    "Tea travelled west.",
    "Tea culture was adapted locally.",
    "Diversity, because traditions developed differently.",
    "Listen respectfully and join dialogue.",
  ]);
  assert.equal(inferOutlineStep(text), 4);
  assert.equal(inferOutlineStep("What was exchanged, and what changed?"), 1);
  assert.equal(inferOutlineStep("Which principle does it reflect, and why?"), 2);
  assert.equal(inferOutlineStep("What attitude should young people take?"), 3);
});

test("rejects incomplete outlines and malformed TLV lengths", () => {
  assert.equal(
    parseFourPartOutline("One, case facts. Tea travelled west. Two, exchange and change."),
    null,
  );

  const malformed = makeTlv("conv", { Stage: { Code: 1 } });
  new DataView(malformed).setUint32(4, 99_999, false);
  assert.throws(() => parseTlvMessage(malformed), /length is invalid/i);
});

