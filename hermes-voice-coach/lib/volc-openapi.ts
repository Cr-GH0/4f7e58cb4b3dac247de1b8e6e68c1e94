import { Signer } from "@volcengine/openapi";

const RTC_API_HOST = "rtc.volcengineapi.com";
const RTC_API_VERSION = "2025-06-01";

function requireServerCredential(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Server configuration is missing ${name}.`);
  }
  return value;
}

export function getRtcServerConfig() {
  return {
    accessKeyId: requireServerCredential("VOLC_ACCESS_KEY_ID"),
    secretKey: requireServerCredential("VOLC_SECRET_ACCESS_KEY"),
    appId: requireServerCredential("VOLC_RTC_APP_ID"),
    appKey: requireServerCredential("VOLC_RTC_APP_KEY"),
  };
}

export async function callRtcOpenApi(
  action: "StartVoiceChat" | "StopVoiceChat" | "RegisterVoicePrint" | "UpdateVoiceChat",
  body: Record<string, unknown>,
) {
  const { accessKeyId, secretKey } = getRtcServerConfig();
  const version = action === "RegisterVoicePrint" ? "2024-12-01" : RTC_API_VERSION;
  const requestData = {
    region: "cn-north-1",
    method: "POST",
    params: {
      Action: action,
      Version: version,
    },
    headers: {
      Host: RTC_API_HOST,
      "Content-Type": "application/json",
    } as Record<string, string>,
    body,
  };

  const signer = new Signer(requestData, "rtc");
  signer.addAuthorization({ accessKeyId, secretKey });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), action === "RegisterVoicePrint" ? 25_000 : 12_000);
  let response: Response;
  try {
    response = await fetch(
      `https://${RTC_API_HOST}?Action=${action}&Version=${version}`,
      {
        method: "POST",
        headers: requestData.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timeout);
  }

  const payload = (await response.json()) as {
    Result?: unknown;
    ResponseMetadata?: {
      Error?: { Code?: string; Message?: string };
    };
  };
  const apiError = payload.ResponseMetadata?.Error;

  if (!response.ok || apiError) {
    const code = apiError?.Code ?? `HTTP_${response.status}`;
    const message = apiError?.Message ?? "Volcengine request failed.";
    throw new Error(`${code}: ${message}`);
  }

  return payload;
}
