import { defaultSettings, validateSettings } from './public/model-settings.js';

export const defaultRevision = () => ({ revision: 0, savedAt: null, settings: defaultSettings() });
const decodeRow = row => row ? { revision: row.id, savedAt: row.saved_at, settings: validateSettings(JSON.parse(row.config)) } : defaultRevision();

export function d1SettingsStore(db) {
  if (!db) throw new Error('The settings database is not configured.');
  return {
    async current() { return decodeRow(await db.prepare('SELECT id, config, saved_at FROM hermes_settings ORDER BY id DESC LIMIT 1').first()); },
    async revision(id) {
      if (id === 0) return defaultRevision();
      const row = await db.prepare('SELECT id, config, saved_at FROM hermes_settings WHERE id = ?').bind(id).first();
      if (!row) throw new Error('These call settings are no longer available. End the call and reconnect.');
      return decodeRow(row);
    },
    async save(settings, expected) {
      const row = await db.prepare('INSERT INTO hermes_settings (config, saved_at) SELECT ?, ? WHERE COALESCE((SELECT MAX(id) FROM hermes_settings), 0) = ? RETURNING id, config, saved_at').bind(JSON.stringify(validateSettings(settings)), new Date().toISOString(), expected).first();
      if (!row) throw new Error('Settings changed in another page. Reload before saving.');
      return decodeRow(row);
    },
  };
}
