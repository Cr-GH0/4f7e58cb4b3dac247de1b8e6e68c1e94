const RTC_ID_PATTERN = /^[A-Za-z0-9_@.-]{1,128}$/;

export type VoiceSessionIdentifiers = {
  roomId: string;
  userId: string;
  botUserId: string;
  taskId: string;
};

export function parseVoiceSessionIdentifiers(
  value: unknown,
): VoiceSessionIdentifiers {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid session request.");
  }

  const record = value as Record<string, unknown>;
  const fields = ["roomId", "userId", "botUserId", "taskId"] as const;
  const parsed = {} as VoiceSessionIdentifiers;

  for (const field of fields) {
    const item = record[field];
    if (typeof item !== "string" || !RTC_ID_PATTERN.test(item)) {
      throw new Error(`Invalid ${field}.`);
    }
    parsed[field] = item;
  }

  return parsed;
}

export function safeApiError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error.";
  if (message.startsWith("Server configuration is missing ")) {
    return message;
  }
  if (/^[A-Za-z0-9_.-]+: /.test(message)) {
    return message;
  }
  if (message.startsWith("Invalid ")) {
    return message;
  }
  return "The voice service could not complete the request.";
}
