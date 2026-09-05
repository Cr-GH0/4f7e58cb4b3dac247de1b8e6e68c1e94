const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const unhex = text => Uint8Array.from(text.match(/.{2}/g) ?? [], b => parseInt(b, 16));
async function key(secret) {
  if (!secret) throw new Error('An admin password has not been configured.');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function signTicket(data, secret) {
  const payload = btoa(JSON.stringify(data));
  return payload + '.' + hex(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(payload)));
}
export async function readTicket(ticket, secret, purpose) {
  if (typeof ticket !== 'string' || ticket.length > 3000) return null;
  const [payload, signature, extra] = ticket.split('.');
  if (extra || !/^[a-f0-9]{64}$/.test(signature ?? '')) return null;
  try {
    if (!await crypto.subtle.verify('HMAC', await key(secret), unhex(signature), encoder.encode(payload))) return null;
    const data = JSON.parse(atob(payload));
    return data.purpose === purpose && data.expiresAt > Date.now() ? data : null;
  } catch { return null; }
}
export async function checkPassword(password, expected) {
  if (!expected) throw new Error('An admin password has not been configured.');
  if (typeof password !== 'string' || password.length > 1024) return false;
  const signature = await crypto.subtle.sign('HMAC', await key(expected), encoder.encode(expected));
  return crypto.subtle.verify('HMAC', await key(expected), signature, encoder.encode(password));
}
export async function callSettings(input, ids, store, secret) {
  const ticket = await readTicket(input.configTicket, secret, 'voice-config');
  if (!ticket || ticket.taskId !== ids.taskId || ticket.roomId !== ids.roomId) throw new Error('These call settings have expired. End the call and reconnect.');
  return (await store.revision(ticket.revision)).settings;
}
export async function startSettings(ids, store, secret) {
  const saved = await store.current();
  const configTicket = await signTicket({ purpose: 'voice-config', taskId: ids.taskId, roomId: ids.roomId, revision: saved.revision, expiresAt: Date.now() + 20 * 60 * 1000 }, secret);
  return { settings: saved.settings, result: { configTicket, configRevision: saved.revision, voiceprintScore: saved.settings.voiceprint.score } };
}
