import { buildHermesVoiceChatRequest } from "@/lib/hermes-config";
import { parseVoiceSessionIdentifiers, safeApiError } from "@/lib/request-validation";
import { callRtcOpenApi, getRtcServerConfig } from "@/lib/volc-openapi";
import { settingsStore } from '@/lib/admin';
import { startSettings } from '../../../../../hermes-volc-standalone/admin-security.js';

export async function POST(request: Request) {
  try {
    const input = await request.json() as Record<string, unknown> | null;
    const identifiers = parseVoiceSessionIdentifiers(input);
    const { appId, appKey } = getRtcServerConfig();
    const configuration = await startSettings(identifiers, await settingsStore(), appKey);
    const body = buildHermesVoiceChatRequest({
      appId,
      roomId: identifiers.roomId,
      taskId: identifiers.taskId,
      studentUserId: identifiers.userId,
      agentUserId: identifiers.botUserId,
      members: input?.members,
      mode: input?.mode,
      context: input?.context,
    }, configuration.settings);
    await callRtcOpenApi("StartVoiceChat", body);
    return Response.json({ ok: true, ...configuration.result });
  } catch (error) {
    return Response.json({ error: safeApiError(error) }, { status: 502 });
  }
}
