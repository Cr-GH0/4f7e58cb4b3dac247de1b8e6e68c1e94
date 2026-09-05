import { readFile, writeFile, rename } from 'node:fs/promises';
import { defaultRevision } from './admin-store.js';
import { validateSettings } from './public/model-settings.js';

export function fileSettingsStore(path) {
  let queue = Promise.resolve();
  const read = async () => {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return {
    async current() { return (await read()).at(-1) ?? defaultRevision(); },
    async revision(id) {
      if (id === 0) return defaultRevision();
      const saved = (await read()).find(x => x.revision === id);
      if (!saved) throw new Error('These call settings are no longer available. End the call and reconnect.');
      return saved;
    },
    save(settings, expected) {
      const work = queue.catch(() => {}).then(async () => {
        const versions = await read();
        if ((versions.at(-1)?.revision ?? 0) !== expected) throw new Error('Settings changed in another page. Reload before saving.');
        const saved = { revision: expected + 1, savedAt: new Date().toISOString(), settings: validateSettings(settings) };
        await writeFile(path + '.tmp', JSON.stringify([...versions, saved]), 'utf8');
        await rename(path + '.tmp', path);
        return saved;
      });
      queue = work;
      return work;
    },
  };
}
