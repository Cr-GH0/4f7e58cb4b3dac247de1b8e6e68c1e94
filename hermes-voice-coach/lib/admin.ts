import { d1SettingsStore } from '../../hermes-volc-standalone/admin-store.js';
import { adminRequest } from '../../hermes-volc-standalone/admin-api.js';

export async function settingsStore() {
  const { env } = await import('cloudflare:workers');
  return d1SettingsStore((env as { DB?: D1Database }).DB);
}
export async function handleAdmin(request: Request) {
  try {
    return await adminRequest(request, await settingsStore(), process.env.HERMES_ADMIN_PASSWORD, {
      accessKeyId: process.env.VOLC_ACCESS_KEY_ID?.trim(), secretKey: process.env.VOLC_SECRET_ACCESS_KEY?.trim(),
    });
  } catch {
    return Response.json({ error: 'Settings storage is unavailable. Check the server database.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
