import { voiceRegistrationRequest } from "@/lib/group-session";
import { safeApiError } from "@/lib/request-validation";
import { callRtcOpenApi, getRtcServerConfig } from "@/lib/volc-openapi";

export async function POST(request: Request) {
  try {
    const { appId } = getRtcServerConfig();
    const body = voiceRegistrationRequest(await request.json(), appId);
    const result = await callRtcOpenApi("RegisterVoicePrint", body);
    if (typeof result.Result !== "string" || !result.Result) throw new Error("RegistrationFailed: No voiceprint ID returned.");
    return Response.json({ voiceprintId: result.Result });
  } catch (error) {
    return Response.json({ error: safeApiError(error) }, { status: 502 });
  }
}
