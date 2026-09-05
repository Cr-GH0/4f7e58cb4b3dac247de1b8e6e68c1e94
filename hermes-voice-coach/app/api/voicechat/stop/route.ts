import { parseVoiceSessionIdentifiers, safeApiError } from "@/lib/request-validation";
import { callRtcOpenApi, getRtcServerConfig } from "@/lib/volc-openapi";

export async function POST(request: Request) {
  try {
    const identifiers = parseVoiceSessionIdentifiers(await request.json());
    const { appId } = getRtcServerConfig();
    await callRtcOpenApi("StopVoiceChat", {
      AppId: appId,
      RoomId: identifiers.roomId,
      TaskId: identifiers.taskId,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: safeApiError(error) }, { status: 502 });
  }
}
