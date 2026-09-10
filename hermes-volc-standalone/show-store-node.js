import { readFile, writeFile, rename, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const emptyState = () => ({ version: 0, active: false, dismissed: false, conversationId: null, triggerText: '', startedAt: null, lastSegment: 0, usedConversations: [] });

function validateContent(content) {
  const encoder = new TextEncoder();
  const need = (value, label) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is missing in show-content.json.`); };
  const bounded = (value, label, limit) => {
    if (encoder.encode(value).length > limit) throw new Error(`${label} exceeds ${limit} UTF-8 bytes; split it into more segments — the speech service would silently truncate it.`);
  };
  need(content.teacherLines?.acknowledged, 'teacherLines.acknowledged');
  need(content.teacherLines?.desktopOffline, 'teacherLines.desktopOffline');
  need(content.teacherLines?.alreadyDone, 'teacherLines.alreadyDone');
  need(content.ack, 'ack');
  bounded(content.ack, 'ack', 900);
  if (!Array.isArray(content.traceSteps) || !content.traceSteps.length) throw new Error('traceSteps is missing in show-content.json.');
  if (!Array.isArray(content.report?.cases) || content.report.cases.length < 1) throw new Error('report.cases is missing in show-content.json.');
  for (const item of content.report.cases) {
    need(item.original, 'report.cases[].original');
    need(item.revised, 'report.cases[].revised');
  }
  if (!Array.isArray(content.report?.method?.steps) || !content.report.method.steps.length) throw new Error('report.method.steps is missing in show-content.json.');
  if (!Array.isArray(content.narration) || (content.narrationMode !== 'dynamic' && !content.narration.length)) throw new Error('narration is missing in show-content.json.');
  for (const item of content.narration) {
    if (!/^[a-z0-9-]{1,32}$/.test(item.id ?? '')) throw new Error(`Invalid narration id in show-content.json.`);
    need(item.text, `narration “${item.id}”.text`);
    bounded(item.text, `narration “${item.id}”.text`, 900);
  }
  return content;
}

// One server process owns these files. The state file keeps the current show
// and which teacher sessions have already performed; audio lives beside it and
// is always swapped in as one complete set.
export function fileShowStore({ statePath, contentPath, audioDir }) {
  let queue = Promise.resolve();
  let audioQueue = Promise.resolve();
  let contentCache = null, contentMtime = 0;
  const readState = async () => {
    try {
      const data = JSON.parse(await readFile(statePath, 'utf8'));
      return {
        ...emptyState(),
        ...data,
        version: Number.isInteger(data.version) ? data.version : 0,
        lastSegment: Number.isInteger(data.lastSegment) ? data.lastSegment : 0,
        usedConversations: Array.isArray(data.usedConversations) ? data.usedConversations.filter(x => typeof x === 'string') : [],
      };
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      if (error instanceof SyntaxError) {
        // A hand-edited or half-written file must not take the show down; keep
        // the broken copy for inspection and continue from a clean state.
        await rename(statePath, `${statePath}.bak`).catch(() => {});
        console.error('[show] state file was unreadable and has been moved to .bak');
        return emptyState();
      }
      throw error;
    }
  };
  const mutate = fn => {
    const work = queue.catch(() => {}).then(async () => {
      const data = await readState();
      const result = fn(data);
      await writeFile(statePath + '.tmp', JSON.stringify(data), 'utf8');
      await rename(statePath + '.tmp', statePath);
      return result;
    });
    queue = work;
    return work;
  };
  const audioFile = id => join(audioDir, `${id}.mp3`);
  return {
    state: readState,
    contentRevision: async () => String((await stat(contentPath)).mtimeMs),
    trigger: (conversationId, text, sources = null) => mutate(data => {
      // The once-per-session rule is checked and written inside the same queued
      // mutation, so two concurrent says cannot both trigger.
      if (data.usedConversations.includes(conversationId)) return { created: false, data };
      if (data.active) return { created: false, busy: true, data };
      data.version += 1;
      data.active = true;
      data.dismissed = false;
      data.conversationId = conversationId;
      data.triggerText = text;
      data.startedAt = new Date().toISOString();
      data.lastSegment = 0;
      data.checkpoint = { phase: 'ack', index: 0, offset: 0 };
      data.performance = null;
      data.sources = sources && typeof sources.html === 'string' && typeof sources.prompt === 'string' ? structuredClone(sources) : null;
      data.usedConversations.push(conversationId);
      return { created: true, data };
    }),
    saveProgress: (version, segment) => mutate(data => {
      if (data.version !== version || !data.active || data.dismissed) return data;
      data.lastSegment = Math.max(data.lastSegment, segment);
      return data;
    }),
    saveCheckpoint: (version, checkpoint) => mutate(data => {
      if (data.version !== version || !data.active) return data;
      const phases = ['ack', 'trace', 'transition', 'narration', 'closing', 'done'];
      const previous = data.checkpoint ?? { phase: 'ack', index: 0, offset: 0 };
      const rank = point => phases.indexOf(point.phase) * 1000000 + point.index * 10000 + point.offset;
      if (rank(checkpoint) < rank(previous)) return data;
      data.checkpoint = checkpoint;
      if (checkpoint.phase === 'narration') data.lastSegment = checkpoint.index;
      if (checkpoint.phase === 'done') data.active = false;
      return data;
    }),
    finish: version => mutate(data => {
      if (data.version === version) data.active = false;
      return data;
    }),
    dismiss: version => mutate(data => {
      if (data.version !== version) return null;
      data.active = false;
      data.dismissed = true;
      return data;
    }),
    retry: version => mutate(data => {
      if (data.version !== version || !data.active || data.dismissed || data.performance?.status !== 'error') return null;
      data.performance = { ...data.performance, status: 'pending', error: null };
      return data;
    }),
    savePerformance: (version, patch) => mutate(data => {
      if (data.version === version && data.active && !data.dismissed) data.performance = { ...data.performance, ...patch };
      return data;
    }),
    async readOpening(key) {
      try {
        if (await readFile(join(audioDir, 'opening.json'), 'utf8') !== key) return null;
        return new Uint8Array(await readFile(audioFile('ack')));
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async writeOpening(bytes, key) {
      await mkdir(audioDir, { recursive: true });
      await writeFile(audioFile('ack') + '.tmp', bytes);
      await rename(audioFile('ack') + '.tmp', audioFile('ack'));
      await writeFile(join(audioDir, 'opening.json'), key, 'utf8');
    },
    async writePerformanceAudio(version, entries) {
      if (!Number.isInteger(version) || version < 1) throw new Error('Invalid show version.');
      const dir = join(audioDir, String(version));
      await mkdir(dir, { recursive: true });
      for (const { id, bytes } of entries) {
        if (!/^[a-z0-9-]{1,32}$/.test(id)) throw new Error('Invalid segment id.');
        await writeFile(join(dir, id + '.mp3.tmp'), bytes);
        await rename(join(dir, id + '.mp3.tmp'), join(dir, id + '.mp3'));
      }
    },
    async readPerformanceAudio(version, id) {
      if (!Number.isInteger(version) || version < 1 || !/^[a-z0-9-]{1,32}$/.test(id)) return null;
      try { return new Uint8Array(await readFile(join(audioDir, String(version), id + '.mp3'))); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async loadContent() {
      const mtime = existsSync(contentPath) ? (await stat(contentPath)).mtimeMs : 0;
      if (contentCache && mtime === contentMtime) return contentCache;
      contentCache = validateContent(JSON.parse(await readFile(contentPath, 'utf8')));
      contentMtime = mtime;
      return contentCache;
    },
    // All-or-nothing: every segment is written to its own temp file first and
    // the set is swapped in only when synthesis fully succeeded.
    writeAudioAll: (entries, content) => {
      const work = audioQueue.catch(() => {}).then(async () => {
        const staged = [];
        try {
          await mkdir(audioDir, { recursive: true });
          for (const { id, bytes } of entries) {
            const tmp = join(audioDir, `.${id}.${process.pid}${Math.random().toString(36).slice(2, 8)}.mp3.tmp`);
            await writeFile(tmp, bytes);
            staged.push({ tmp, final: audioFile(id) });
          }
        } catch (error) {
          for (const { tmp } of staged) await rm(tmp, { force: true });
          throw error;
        }
        // If any rename fails, a partially replaced set must not advertise readiness.
        await rm(join(audioDir, 'manifest.json'), { force: true });
        for (const { tmp, final } of staged) await rename(tmp, final);
        if (content) await writeFile(join(audioDir, 'manifest.json'), JSON.stringify({ ack: content.ack, narration: content.narration, voice: content.voice }), 'utf8');
      });
      audioQueue = work;
      return work;
    },
    async readAudio(id) {
      if (!/^[a-z0-9-]{1,32}$/.test(id)) return null;
      try { return new Uint8Array(await readFile(audioFile(id))); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async audioReady() {
      try {
        const content = await this.loadContent();
        const manifest = JSON.parse(await readFile(join(audioDir, 'manifest.json'), 'utf8'));
        return JSON.stringify(manifest) === JSON.stringify({ ack: content.ack, narration: content.narration, voice: content.voice }) && existsSync(audioFile('ack')) && content.narration.every(item => existsSync(audioFile(item.id)));
      } catch { return false; }
    },
  };
}
