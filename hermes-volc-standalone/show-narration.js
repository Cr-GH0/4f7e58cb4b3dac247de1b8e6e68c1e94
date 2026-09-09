import { completeReply, synthesizeSpeech } from './public/talk-api.js';

export const NARRATION_IDS = ['intro', 'case1', 'case2', 'method'];

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
  async function generate(snapshot) {
    let current = await store.state();
    if (current.version !== snapshot.version || current.performance?.status === 'ready') return;
    const previous = current.performance;
    await store.savePerformance(snapshot.version, { status: 'generating', error: null });
    try {
      if (!arkKey || !speech) throw new Error('Narration model or voice credentials are unavailable.');
      const configured = await settings();
      const content = await store.loadContent();
      const { prompt, html } = await loadSources();
      let narration = previous?.narration;
      if (!narration?.length) {
        const body = {
          model: configured.llm.model,
          messages: [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify({ teacherRequest: snapshot.triggerText, report: reportText(html) }) }],
          temperature: 0.7, top_p: 0.9, max_tokens: 1800,
          thinking: { type: 'disabled' }, response_format: { type: 'json_object' },
        };
        narration = parseNarration(await completeReply(body, arkKey, fetcher));
      }
      await store.savePerformance(snapshot.version, { status: 'synthesizing', narration });
      const tts = { ...configured.tts, speaker: content.voice?.speaker?.trim() || configured.tts.speaker, speechRate: content.voice?.speechRate ?? configured.tts.speechRate };
      const entries = await Promise.all([{ id: 'ack', text: content.ack }, ...narration].map(async segment => {
        const result = await synthesizeSpeech(segment.text, speech, { tts }, fetcher);
        return { id: segment.id, bytes: Buffer.from(result.audio, 'base64') };
      }));
      await store.writePerformanceAudio(snapshot.version, entries);
      await store.savePerformance(snapshot.version, { status: 'ready', narration, generatedAt: new Date().toISOString(), error: null });
    } catch (error) {
      console.error('[show narration]', error instanceof Error ? error.message : error);
      await store.savePerformance(snapshot.version, { status: 'error', error: 'Mimi could not prepare the spoken explanation.' });
    }
  }
  return {
    ensure(snapshot) {
      if (jobs.has(snapshot.version)) return jobs.get(snapshot.version);
      const job = generate(snapshot).finally(() => jobs.delete(snapshot.version));
      jobs.set(snapshot.version, job);
      return job;
    },
  };
}
