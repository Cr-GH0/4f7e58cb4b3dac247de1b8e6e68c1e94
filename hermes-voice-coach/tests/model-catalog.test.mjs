import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCatalog } from '../../hermes-volc-standalone/model-catalog.js';
import { adminRequest } from '../../hermes-volc-standalone/admin-api.js';
import { defaultSettings } from '../../hermes-volc-standalone/public/model-settings.js';

const credentials = { accessKeyId: 'catalog-test-key', secretKey: 'catalog-test-secret' };
const family = (Name, domain = 'LLM') => ({ Name, DisplayName: Name, FoundationModelTag: { Domains: [domain] } });
function provider(failed = '', calls = []) {
  return async (url, init) => {
    const action = new URL(url).searchParams.get('Action'), body = JSON.parse(init.body);
    calls.push({ action, body });
    assert.match(init.headers.Authorization, /^HMAC-SHA256 /);
    if (action === failed) return Response.json({ ResponseMetadata: { Error: { Code: 'AccessDenied' } } }, { status: 403 });
    const result = (() => {
      if (action === 'ListFoundationModels') return { TotalCount: 3, Items: body.PageNumber === 1 ? [family('coach'), family('image', 'ComputerVision')] : [family('other')] };
      if (action === 'ListFoundationModelVersions') return { TotalCount: 2, Items: [
        { Status: 'Published', ModelId: `actual-${body.FoundationModelName}-id`, ModelVersion: 'v2' },
        { Status: 'Shutdown', ModelId: 'retired-id', ModelVersion: 'v1' },
      ] };
      if (action === 'ListEndpoints') return { TotalCount: 3, Items: [
        { Id: 'ep-coach', Name: 'Custom coach', Status: 'Running', ModelReference: { FoundationModel: { Name: 'coach' } } },
        { Id: 'ep-image', Name: 'Image endpoint', Status: 'Running', ModelReference: { FoundationModel: { Name: 'image' } } },
        { Id: 'ep-stopped', Name: 'Stopped', Status: 'Stopped' },
      ] };
      if (action === 'InnerDescribeModelEndpoints') return { TotalCount: 1, Items: [{ ModelId: 'actual-coach-id', Status: 'Running' }] };
      if (action === 'ListSpeakers') {
        assert.equal(typeof body.Limit, 'number');
        return { Total: 4, Speakers: body.Page === 1 ? [
          { VoiceType: 'bilingual', Name: '双语声音', ResourceID: 'seed-tts-2.0', Languages: [{ Language: 'zh-cn', Flag: '🇨🇳🇺🇸' }], TrialURL: 'https://example.com/demo.mp3' },
          { VoiceType: 'unsupported', ResourceID: 'seed-tts-2.0', BidirectionalUnsupport: true },
        ] : [
          { VoiceType: 'legacy', Name: 'English voice', ResourceID: 'volc.service_type.10029', Languages: [{ Language: 'en-gb' }], TrialURL: 'javascript:alert(1)' },
          { VoiceType: 'offline', ResourceID: 'seed-tts-1.0', Status: 'offline' },
        ] };
      }
      throw new Error(`Unexpected provider action ${action}`);
    })();
    return Response.json({ Result: result });
  };
}

test('discovery reads all pages, preserves real IDs, filters incompatible models and maps bilingual voices to matching TTS', async () => {
  const calls = [], catalog = await discoverCatalog(credentials, provider('', calls));
  assert.deepEqual(catalog.llm.items.map(x => x.id).sort(), ['actual-coach-id', 'actual-other-id', 'ep-coach']);
  assert.equal(catalog.llm.items.find(x => x.id === 'actual-coach-id').enabled, true);
  assert.equal(catalog.llm.items.find(x => x.id === 'actual-other-id').enabled, false);
  assert.equal(calls.some(x => x.action === 'ListFoundationModelVersions' && x.body.FoundationModelName === 'image'), false);
  assert.equal(catalog.voices.items.length, 2);
  assert.deepEqual(catalog.voices.items[0].languages, ['Chinese', 'English']);
  assert.equal(catalog.voices.items[1].resourceId, 'seed-tts-1.0');
  assert.equal(catalog.voices.items[1].sample, '');
  assert.deepEqual(catalog.llm.warnings, []);
});

test('one unavailable provider list does not erase the remaining choices or claim they are all enabled', async () => {
  const catalog = await discoverCatalog(credentials, provider('ListSpeakers'));
  assert.equal(catalog.llm.items.length, 3);
  assert.deepEqual(catalog.voices.items, []);
  assert.match(catalog.voices.error, /cannot read the voice list/);
});

test('catalog requires an administrator login before any provider reads', async () => {
  const original = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error('must not request'); };
  try {
    const response = await adminRequest(new Request('http://localhost/api/admin/catalog'), { current: () => ({ settings: defaultSettings() }) }, 'test-password', credentials);
    assert.equal(response.status, 401);
    assert.equal(fetched, false);
  } finally { globalThis.fetch = original; }
});
