import { buildVoiceUpdates } from '@/lib/hermes-config';
import { parseVoiceSessionIdentifiers, safeApiError } from '@/lib/request-validation';
import { callRtcOpenApi, getRtcServerConfig } from '@/lib/volc-openapi';
import { settingsStore } from '@/lib/admin';
import { callSettings } from '../../../../../hermes-volc-standalone/admin-security.js';

export async function POST(request: Request) {
  try {
    const input = await request.json() as Record<string, unknown>;
    const ids = parseVoiceSessionIdentifiers(input);
    const { appId, appKey } = getRtcServerConfig();
    const settings = input.action === 'interrupt' ? undefined : await callSettings(input, ids, await settingsStore(), appKey);
    for (const body of buildVoiceUpdates(input, appId, ids, settings)) await callRtcOpenApi('UpdateVoiceChat', body);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: safeApiError(error) }, { status: 502 });
  }
}
