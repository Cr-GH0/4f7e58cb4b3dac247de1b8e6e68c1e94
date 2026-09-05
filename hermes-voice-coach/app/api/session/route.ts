import { generateRtcToken } from "@/lib/rtc-token";
import { getRtcServerConfig } from "@/lib/volc-openapi";
import { safeApiError } from "@/lib/request-validation";

export async function POST() {
  try {
    const { appId, appKey } = getRtcServerConfig();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const roomId = `hermes_${suffix}`;
    const userId = `student_${suffix}`;
    const botUserId = `hermes_ai_${suffix}`;
    const taskId = `task_${suffix}`;
    const expiresAt = Math.floor(Date.now() / 1000) + 12 * 60;
    const rtcToken = generateRtcToken({
      appId,
      appKey,
      roomId,
      userId,
      expiresAt,
    });
    return Response.json({
      appId,
      roomId,
      userId,
      botUserId,
      taskId,
      rtcToken,
      expiresAt,
    });
  } catch (error) {
    return Response.json({ error: safeApiError(error) }, { status: 503 });
  }
}
