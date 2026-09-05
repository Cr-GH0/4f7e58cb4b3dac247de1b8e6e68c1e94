import { createHmac, randomBytes } from "node:crypto";

const TOKEN_VERSION = "001";

export const RTC_PRIVILEGES = {
  publishStream: 0,
  publishAudioStream: 1,
  publishVideoStream: 2,
  publishDataStream: 3,
  subscribeStream: 4,
} as const;

class ByteBuffer {
  private chunks: Buffer[] = [];

  putUint16(value: number) {
    const chunk = Buffer.allocUnsafe(2);
    chunk.writeUInt16LE(value, 0);
    this.chunks.push(chunk);
    return this;
  }

  putUint32(value: number) {
    const chunk = Buffer.allocUnsafe(4);
    chunk.writeUInt32LE(value >>> 0, 0);
    this.chunks.push(chunk);
    return this;
  }

  putBytes(value: Buffer) {
    if (value.length > 0xffff) {
      throw new Error("RTC token field is too long.");
    }
    this.putUint16(value.length);
    this.chunks.push(value);
    return this;
  }

  putString(value: string) {
    return this.putBytes(Buffer.from(value, "utf8"));
  }

  putPrivilegeMap(privileges: Record<number, number>) {
    const entries = Object.entries(privileges).sort(
      ([left], [right]) => Number(left) - Number(right),
    );
    this.putUint16(entries.length);
    for (const [privilege, expiresAt] of entries) {
      this.putUint16(Number(privilege));
      this.putUint32(expiresAt);
    }
    return this;
  }

  pack() {
    return Buffer.concat(this.chunks);
  }
}

export function generateRtcToken({
  appId,
  appKey,
  roomId,
  userId,
  expiresAt,
}: {
  appId: string;
  appKey: string;
  roomId: string;
  userId: string;
  expiresAt: number;
}) {
  if (appId.length !== 24) {
    throw new Error("VOLC_RTC_APP_ID must contain 24 characters.");
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(4).readUInt32LE(0);
  const privileges: Record<number, number> = {
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

