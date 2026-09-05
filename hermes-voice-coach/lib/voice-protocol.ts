export type TlvMessage = {
  type: string;
  payload: Record<string, unknown>;
};

export type OutlineParts = [string, string, string, string];

export function parseTlvMessage(buffer: ArrayBuffer): TlvMessage {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 8) {
    throw new Error("The RTC message is shorter than its TLV header.");
  }

  const type = new TextDecoder()
    .decode(bytes.subarray(0, 4))
    .replaceAll("\0", "");
  const length = new DataView(buffer, 4, 4).getUint32(0, false);
  if (length > bytes.byteLength - 8) {
    throw new Error("The RTC message length is invalid.");
  }

  const value = new TextDecoder().decode(bytes.subarray(8, 8 + length));
  const payload = JSON.parse(value) as Record<string, unknown>;
  return { type, payload };
}

export function parseFourPartOutline(text: string): OutlineParts | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match = normalized.match(
    /(?:Here is your four-part outline\.?)?\s*One,?\s*case facts\.\s*(.*?)\s*Two,?\s*exchange and change\.\s*(.*?)\s*Three,?\s*principle and reason\.\s*(.*?)\s*Four,?\s*youth attitude or action\.\s*(.*?)(?:\s*Does this accurately represent your ideas\??|$)/i,
  );
  if (!match) {
    return null;
  }

  const parts = match.slice(1, 5).map((part) => part.trim());
  return parts.every(Boolean) ? (parts as OutlineParts) : null;
}

export function inferOutlineStep(aiText: string) {
  const normalized = aiText.toLowerCase();
  if (
    normalized.includes("here is your four-part outline") ||
    normalized.includes("your outline is ready")
  ) {
    return 4;
  }
  if (
    normalized.includes("what attitude") ||
    normalized.includes("what do you think young people should do") ||
    normalized.includes("youth action")
  ) {
    return 3;
  }
  if (
    normalized.includes("which principle") ||
    normalized.includes("what detail from your case explains that choice")
  ) {
    return 2;
  }
  if (
    normalized.includes("what was exchanged") ||
    normalized.includes("what changed")
  ) {
    return 1;
  }
  return 0;
}

