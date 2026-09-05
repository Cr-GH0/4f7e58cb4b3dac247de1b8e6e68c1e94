import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDatabase } from './admin-fixture.mjs';
import { defaultSettings, validateSettings } from '../../hermes-volc-standalone/public/model-settings.js';
import { d1SettingsStore } from '../../hermes-volc-standalone/admin-store.js';
import { fileSettingsStore } from '../../hermes-volc-standalone/admin-store-node.js';
import { adminRequest } from '../../hermes-volc-standalone/admin-api.js';
import { handleRequest } from '../../hermes-volc-standalone/worker.js';
import { buildHermesVoiceChatRequest } from '../../hermes-volc-standalone/public/voice-chat-config.js';
import { reduceSubtitle } from '../../hermes-volc-standalone/public/group-session.js';

const request = (path, method = 'GET', body, cookie = '', origin = 'http://localhost') => new Request(`http://localhost/api/admin/${path}`, {method,headers:{origin,cookie,'Content-Type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})});
test('admin password gates reads and writes; invalid settings, cross-origin requests and stale saves do not alter configuration', async () => {
  const db = testDatabase(), store = d1SettingsStore(db), password = 'test-admin-password';
  const call = req => adminRequest(req,store,password);
  assert.equal((await call(request('settings'))).status,401);
  assert.equal((await call(request('login','POST',{password:'wrong'}))).status,401);
  const login = await call(request('login','POST',{password}));
  assert.equal(login.status,200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const value = defaultSettings(); value.asr.resourceId = 'volc.bigasr.sauc.duration'; value.prompts.conversation = 'Use this editable instruction.';
  assert.equal((await call(request('settings','PUT',{revision:0,settings:value},cookie,'https://other.example'))).status,403);
  const result = await call(request('settings','PUT',{revision:0,settings:value},cookie));
  assert.equal(result.status,200); assert.equal((await result.json()).revision,1);
  const invalid = structuredClone(value); invalid.tts.speaker = '';
  assert.equal((await call(request('settings','PUT',{revision:1,settings:invalid},cookie))).status,400);
  assert.equal((await call(request('settings','PUT',{revision:0,settings:defaultSettings()},cookie))).status,409);
  assert.deepEqual((await (await call(request('settings','GET',null,cookie))).json()).settings,value);
  assert.equal((await store.revision(0)).settings.asr.resourceId,'volc.seedasr.sauc.duration');
  const logout = await call(request('logout','POST',{},cookie)); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  db.close();
});

test('all configured models and prompts reach voice requests; saving during a call cannot replace its configuration', async () => {
  const db = testDatabase(), store = d1SettingsStore(db);
  const v = defaultSettings(); v.llm.model='model-test-v2'; v.asr.resourceId='volc.bigasr.sauc.duration'; v.tts.resourceId='seed-tts-1.0'; v.tts.speaker='voice-test'; v.tts.speechRate=-10; v.voiceprint.score=65; v.prompts.conversation='First conversation instruction.'; v.prompts.outline='First outline instruction.';
  await store.save(v,0);
  const env = {DB:db,VOLC_ACCESS_KEY_ID:'test',VOLC_SECRET_ACCESS_KEY:'test',VOLC_RTC_APP_ID:'a'.repeat(24),VOLC_RTC_APP_KEY:'test'};
  const ids={roomId:'test-room',taskId:'test-task',userId:'test-user',botUserId:'test-bot'}, members=[1,2,3].map(i=>({memberId:`p${i}`,name:`P${i}`,voiceprintId:`v${i}`}));
  const calls=[], original=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{calls.push(JSON.parse(init.body));return Response.json({Result:'ok'});};
  const voice = (path,body)=>handleRequest(new Request(`http://localhost/api/voicechat/${path}`,{method:'POST',body:JSON.stringify({...ids,...body})}),env);
  try {
    const started=await (await voice('start',{mode:'group',members})).json();
    const body=calls[0];
    assert.equal(body.Config.LLMConfig.ModelName,v.llm.model);
    assert.equal(body.Config.ASRConfig.ProviderParams.Credential.ApiResourceId,v.asr.resourceId);
    assert.equal(body.Config.TTSConfig.ProviderParams.Credential.ResourceId,v.tts.resourceId);
    const tts=JSON.parse(body.Config.TTSConfig.ProviderParams.VolcanoTTSParameters).req_params;
    assert.equal(tts.speaker,v.tts.speaker); assert.equal(tts.audio_params.speech_rate,-10);
    assert.equal(body.AgentConfig.VoicePrint.Score,65); assert.equal(started.voiceprintScore,65);
    const edited=structuredClone(v); edited.prompts.conversation='Later conversation instruction.'; await store.save(edited,1);
    await voice('update',{...started,action:'respond',purpose:'outline',context:'{"revision":3}',text:'Outline for p1'});
    assert.deepEqual(calls[1].Parameters.Config.LLMConfig.SystemMessages,[v.prompts.conversation,v.prompts.outline,'Authoritative application record (JSON data):\n{"revision":3}']);
    assert.equal(calls[2].Command,'ExternalTextToLLM');
    await assert.rejects(voice('update',{...started,configTicket:started.configTicket+'x',action:'respond',context:'{}',text:'invalid'}),/settings have expired/);
    await voice('start',{mode:'group',members}); assert.equal(calls.at(-1).Config.LLMConfig.SystemMessages[0],edited.prompts.conversation);
    const endpoint=structuredClone(v); endpoint.llm.target='endpoint'; endpoint.llm.model='ep-test';
    const llm=buildHermesVoiceChatRequest({mode:'group',members},validateSettings(endpoint)).Config.LLMConfig;
    assert.equal(llm.EndPointId,'ep-test'); assert.equal('ModelName' in llm,false);
  } finally {globalThis.fetch=original;db.close();}
});

test('speaker attribution follows the configured threshold instead of the old hard-coded threshold', () => {
  const context={taskId:'task',botUserId:'bot',members:[{memberId:'person',voiceprintId:'print'}],voiceprintScore:65};
  const speech={roundId:1,sequence:0,userId:'student',voiceprintId:'print',voiceprintScore:60,text:'My idea',definite:true,paragraph:true};
  assert.equal(reduceSubtitle([],speech,context)[0].speakerId,null);
  assert.equal(reduceSubtitle([],{...speech,voiceprintScore:70},context)[0].speakerId,'person');
});

test('standalone configuration survives recreating its store and preserves previous call revisions', async () => {
  const dir=await mkdtemp(join(tmpdir(),'hermes-admin-')),path=join(dir,'settings.json');
  try {
    const first=fileSettingsStore(path); const settings=defaultSettings(); settings.tts.speaker='another-voice';
    await first.save(settings,0);
    const restarted=fileSettingsStore(path); assert.deepEqual((await restarted.current()).settings,settings);
    await restarted.save(defaultSettings(),1);
    assert.deepEqual((await restarted.revision(1)).settings,settings);
    await assert.rejects(restarted.save(settings,1),/another page/);
  } finally { await rm(path,{force:true}); await rm(path+'.tmp',{force:true}); await rmdir(dir); }
});
