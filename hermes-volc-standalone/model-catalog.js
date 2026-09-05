// Read-only provider discovery, shared by Vinext, Node and Workers.
// API contracts: Ark 2024-01-01 ListFoundationModels / ListFoundationModelVersions /
// ListEndpoints / InnerDescribeModelEndpoints; speech_saas_prod 2025-05-20 ListSpeakers.
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
const hash = async text => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
async function hmac(key, text) {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', imported, encoder.encode(text));
}

export async function catalogApi(action, body, credentials, fetcher = fetch) {
  const speech = action === 'ListSpeakers';
  const service = speech ? 'speech_saas_prod' : 'ark';
  const host = speech ? 'open.volcengineapi.com' : 'ark.cn-beijing.volcengineapi.com';
  const version = speech ? '2025-05-20' : '2024-01-01';
  const query = `Action=${action}&Version=${version}`;
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:-]/g, '');
  const day = date.slice(0, 8), region = 'cn-beijing', scope = `${day}/${region}/${service}/request`;
  const payload = JSON.stringify(body), digest = await hash(payload);
  const signed = 'host;x-content-sha256;x-date';
  const canonical = `POST\n/\n${query}\nhost:${host}\nx-content-sha256:${digest}\nx-date:${date}\n\n${signed}\n${digest}`;
  let key = encoder.encode(credentials.secretKey);
  for (const part of [day, region, service, 'request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, `HMAC-SHA256\n${date}\n${scope}\n${await hash(canonical)}`));
  const response = await fetcher(`https://${host}/?${query}`, {
    method: 'POST', body: payload, signal: AbortSignal.timeout(12000),
    headers: {
      'Content-Type': 'application/json', 'X-Date': date, 'X-Content-Sha256': digest,
      Authorization: `HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    },
  });
  const data = await response.json();
  if (!response.ok || data.ResponseMetadata?.Error) {
    const error = new Error('Volcengine did not return the list.');
    error.code = data.ResponseMetadata?.Error?.Code || `HTTP_${response.status}`;
    throw error;
  }
  return data.Result;
}

async function pages(call, action, extra = {}) {
  const speech = action === 'ListSpeakers', items = [];
  for (let page = 1; ; page++) {
    // The live ListSpeakers API requires a number for Limit (the Python SDK says str).
    const result = await call(action, { ...extra, ...(speech ? { Page: page, Limit: 100 } : { PageNumber: page, PageSize: 100 }) });
    const batch = speech ? result?.Speakers : result?.Items;
    if (!Array.isArray(batch)) throw new Error('The model list could not be read. Try loading it again.');
    items.push(...batch);
    if (!batch.length || items.length >= (speech ? result.Total : result.TotalCount)) return items;
  }
}

export const SPEECH_MODELS = {
  asr: [
    { id: 'volc.seedasr.sauc.duration', name: 'Doubao Speech Recognition 2.0' },
    { id: 'volc.bigasr.sauc.duration', name: 'Doubao Speech Recognition 1.0' },
  ],
  tts: [
    { id: 'seed-tts-2.0', name: 'Doubao Speech Synthesis 2.0' },
    { id: 'seed-tts-1.0', name: 'Doubao Speech Synthesis 1.0' },
  ],
};
const resource = id => id === 'volc.service_type.10029' ? 'seed-tts-1.0' : id;
const safeAudio = value => { try { return new URL(value).protocol === 'https:' ? value : ''; } catch { return ''; } };
const languageNames = { 'zh-cn': 'Chinese', en: 'English', 'en-us': 'American English', 'en-gb': 'British English', ja: 'Japanese', es: 'Spanish', 'es-mx': 'Spanish', id: 'Indonesian', pt: 'Portuguese', de: 'German', fr: 'French', ko: 'Korean' };

export function speakerChoice(speaker) {
  const languages = new Set();
  for (const entry of speaker.Languages || []) {
    if (entry.Language) languages.add(languageNames[entry.Language] || entry.Language);
    // The provider uses flags for bilingual voices while Language contains only zh-cn.
    if (entry.Flag?.includes('🇺🇸') || entry.Flag?.includes('🇬🇧')) languages.add('English');
  }
  return {
    id: speaker.VoiceType, name: speaker.Name || speaker.VoiceType, resourceId: resource(speaker.ResourceID),
    gender: ({'女':'Female','男':'Male','female':'Female','male':'Male'})[speaker.Gender] || speaker.Gender || '', languages: [...languages], description: speaker.Description || '',
    sample: safeAudio(speaker.ShortTrialURL || speaker.TrialURL),
  };
}

const failure = (error, subject) => /AccessDenied|Forbidden|Unauthorized/.test(error?.code || '')
  ? `The server account cannot read ${subject}. Enable list access for this account and try again.`
  : `Could not load ${subject}. Try again. Your saved selection is kept.`;

export async function discoverCatalog(credentials, fetcher = fetch) {
  const call = (action, body) => catalogApi(action, body, credentials, fetcher);
  if (!credentials?.accessKeyId || !credentials?.secretKey) throw new Error('No Volcengine account is configured on the server.');
  const [families, endpoints, opened, speakers] = await Promise.allSettled([
    pages(call, 'ListFoundationModels'), pages(call, 'ListEndpoints'),
    pages(call, 'InnerDescribeModelEndpoints'), pages(call, 'ListSpeakers'),
  ]);
  const items = [], warnings = [];
  const enabled = new Set(opened.status === 'fulfilled' ? opened.value.filter(x => x.Status === 'Running').map(x => x.ModelId) : []);
  if (families.status === 'fulfilled') {
    const queue = families.value.filter(x => x.FoundationModelTag?.Domains?.includes('LLM'));
    // Bound concurrent reads; actual IDs come from version responses, never concatenated guesses.
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const family = queue.shift();
        try {
          const versions = await pages(call, 'ListFoundationModelVersions', { FoundationModelName: family.Name });
          for (const v of versions) {
            if (v.Status !== 'Published' || !v.ModelId) continue;
            items.push({ id: v.ModelId, target: 'model', name: family.DisplayName || family.Name, version: v.ModelVersion,
              description: v.Description || family.DisplayDescription || '', enabled: enabled.has(v.ModelId) });
          }
        } catch { warnings.push(`Could not load versions for ${family.DisplayName || family.Name}.`); }
      }
    }));
  } else warnings.push(failure(families.reason, 'the conversation model list'));
  if (endpoints.status === 'fulfilled') {
    for (const ep of endpoints.value) {
      if (ep.Status !== 'Running') continue;
      const family = ep.ModelReference?.FoundationModel?.Name;
      if (family && families.status === 'fulfilled' && !families.value.find(x => x.Name === family)?.FoundationModelTag?.Domains?.includes('LLM')) continue;
      items.push({ id: ep.Id, target: 'endpoint', name: ep.Name || ep.Id, version: ep.ModelReference?.FoundationModel?.ModelVersion || '', description: 'Custom endpoint on this account', enabled: true });
    }
  } else warnings.push(failure(endpoints.reason, 'custom endpoints'));
  if (opened.status === 'rejected') warnings.push('Model activation status is unavailable. You can still select from the list.');
  const voices = speakers.status === 'fulfilled' ? speakers.value
    .filter(s => s.Status !== 'offline' && !s.BidirectionalUnsupport && SPEECH_MODELS.tts.some(m => m.id === resource(s.ResourceID)))
    .map(speakerChoice) : [];
  return {
    fetchedAt: new Date().toISOString(),
    llm: { items: items.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name) || b.version.localeCompare(a.version)), warnings },
    asr: SPEECH_MODELS.asr, tts: SPEECH_MODELS.tts,
    voices: { items: voices, error: speakers.status === 'rejected' ? failure(speakers.reason, 'the voice list') : '' },
  };
}

let cache;
export async function modelCatalog(credentials, refresh = false) {
  const account = credentials?.accessKeyId;
  if (!refresh && cache?.account === account && cache.expires > Date.now()) return cache.promise;
  const promise = discoverCatalog(credentials);
  const entry = { account, promise, expires: Date.now() + 5 * 60 * 1000 };
  cache = entry;
  try {
    const result = await promise;
    if (result.llm.warnings.length || result.voices.error) entry.expires = 0;
    return result;
  } catch (error) { if (cache === entry) cache = undefined; throw error; }
}
