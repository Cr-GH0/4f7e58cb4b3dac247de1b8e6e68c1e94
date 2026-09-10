import { completeReply, synthesizeSpeech } from './public/talk-api.js';

export const NARRATION_IDS = ['intro', 'case1', 'case2', 'method'];
const OUTPUT_FORMAT = `Playback format: return only a JSON object with a narration array of exactly four entries, using IDs intro, case1, case2, method in that order. These are consecutive parts of ONE spoken response, not four turns. The IDs are playback labels; follow the supplied report and speaking instructions for subject matter. Each entry has id and text. Text must be plain spoken English without Markdown, below 900 UTF-8 bytes per entry. This format controls delivery only; do not mention it aloud. TIMING: the spoken report has 49.2 seconds. This timing limit takes priority over any longer word counts above. Write 110–125 words TOTAL: about 14–16 for intro, 30–35 for case1, 43–48 for case2, and 23–26 for method. Keep the report's key relationships, compress examples instead of reading quotations, and finish each thought. Do not mention the time limit.`;

export function reportText(html) {
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|rsquo|lsquo|rdquo|ldquo|mdash|ndash|nbsp);/g, value => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&rsquo;': '’', '&lsquo;': '‘', '&rdquo;': '”', '&ldquo;': '“', '&mdash;': '—', '&ndash;': '–', '&nbsp;': ' ' }[value]))
    .replace(/\s+/g, ' ').trim();
}

export function parseNarration(raw) {
  const data = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (!Array.isArray(data.narration) || data.narration.length !== 4) throw new Error('Narration must contain four sections.');
  return data.narration.map((item, i) => {
    if (item.id !== NARRATION_IDS[i] || typeof item.text !== 'string' || !item.text.trim()) throw new Error('Narration sections are invalid.');
    const text = item.text.trim();
    if (new TextEncoder().encode(text).length > 900 || /\p{Script=Han}/u.test(text)) throw new Error('Narration must be English and fit the speech service.');
    return { id: item.id, text };
  });
}

// One generated result per performance, persisted before synthesis. Refreshing
// or reconnecting never asks the model to rewrite a partially spoken report.
export function createNarrationGenerator({ store, settings, speech, arkKey, loadSources, fetcher = fetch }) {
  const jobs = new Map();
  let openingJob;
  const retryOnce = async action => {
    try { return await action(); } catch { return action(); }
  };
  async function prepareOpening() {
    if (openingJob) return openingJob;
    openingJob = (async () => {
      const content = await store.loadContent(), configured = await settings();
      const tts = { ...configured.tts, speaker: content.voice?.speaker?.trim() || configured.tts.speaker, speechRate: content.voice?.speechRate ?? configured.tts.speechRate };
      const key = JSON.stringify({ text: content.ack, tts });
      const cached = await store.readOpening(key);
      if (cached) return cached;
      if (!speech) throw new Error('Opening voice is unavailable.');
      const result = await retryOnce(() => synthesizeSpeech(content.ack, speech, { tts }, fetcher));
      const bytes = Buffer.from(result.audio, 'base64');
      await store.writeOpening(bytes, key);
      return bytes;
    })().finally(() => { openingJob = null; });
    return openingJob;
  }
  async function generate(snapshot) {
    let current = await store.state();
    if (current.version !== snapshot.version || !current.active || current.dismissed || current.performance?.status === 'ready') return;
    const alive = async () => { const s = await store.state(); return s.version === snapshot.version && s.active && !s.dismissed; };
    const previous = current.performance;
    await store.savePerformance(snapshot.version, { status: 'generating', error: null });
    try {
      if (!arkKey || !speech) throw new Error('Narration model or voice credentials are unavailable.');
      const configured = await settings();
      const content = await store.loadContent();
      const { prompt, html } = current.sources ?? await loadSources();
      let narration = previous?.narration;
      if (!narration?.length) {
        const body = {
          model: configured.llm.model,
          messages: [{ role: 'system', content: prompt + '\n\n' + OUTPUT_FORMAT }, { role: 'user', content: JSON.stringify({ teacherRequest: snapshot.triggerText, report: reportText(html) }) }],
          temperature: 0.7, top_p: 0.9, max_tokens: 900,
          thinking: { type: 'disabled' }, response_format: { type: 'json_object' },
        };
        narration = await retryOnce(async () => {
          const result = parseNarration(await completeReply(body, arkKey, fetcher));
          if (result.reduce((count, part) => count + part.text.split(/\s+/).length, 0) > 140) throw new Error('The explanation is too long for this presentation.');
          return result;
        });
      }
      if (!await alive()) return;
      await store.savePerformance(snapshot.version, { status: 'synthesizing', narration });
      const tts = { ...configured.tts, speaker: content.voice?.speaker?.trim() || configured.tts.speaker, speechRate: content.voice?.speechRate ?? configured.tts.speechRate };
      const entries = await Promise.all(narration.map(async segment => {
        const result = await retryOnce(() => synthesizeSpeech(segment.text, speech, { tts }, fetcher));
        return { id: segment.id, bytes: Buffer.from(result.audio, 'base64') };
      }));
      if (!await alive()) return;
      await store.writePerformanceAudio(snapshot.version, entries);
      await store.savePerformance(snapshot.version, { status: 'ready', narration, generatedAt: new Date().toISOString(), error: null });
    } catch (error) {
      console.error('[show narration]', error instanceof Error ? error.message : error);
      await store.savePerformance(snapshot.version, { status: 'error', error: 'Mimi could not prepare the spoken explanation.' });
    }
  }
  return {
    prepareOpening,
    ensure(snapshot) {
      if (jobs.has(snapshot.version)) return jobs.get(snapshot.version);
      const job = generate(snapshot).finally(() => jobs.delete(snapshot.version));
      jobs.set(snapshot.version, job);
      return job;
    },
  };
}
