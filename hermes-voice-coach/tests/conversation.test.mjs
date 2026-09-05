import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { newConversation, participants, updatePerson, replacePerson, addText, saveDraft, correctAttribution, correctText, receiveSubtitle, readWorkspace, conversationContext, responseDecision, personName } from '../../hermes-volc-standalone/public/conversation.js';
import { createVoiceRuntime, chooseMicrophone, capturedMicrophone } from '../../hermes-volc-standalone/public/voice-runtime.js';
import { buildHermesVoiceChatRequest, buildVoiceUpdates } from '../../hermes-volc-standalone/public/voice-chat-config.js';
import { handleRequest } from '../../hermes-volc-standalone/worker.js';
import { createInputDrafts } from '../../hermes-volc-standalone/public/input-drafts.js';
import { peopleForReview } from '../../hermes-volc-standalone/public/coach-view.js';
import { testDatabase } from './admin-fixture.mjs';
import { signTicket } from '../../hermes-volc-standalone/admin-security.js';

const memory = initial => { const map = new Map(Object.entries(initial ?? {})); return {getItem:k=>map.get(k) ?? null,setItem:(k,v)=>map.set(k,v)}; };
const tick = () => new Promise(resolve=>setImmediate(resolve));

test('a first-visit draft still belongs to the current conversation after reloading',()=>{
  const storage = memory();
  const first = createVoiceRuntime({storage});
  const id = first.getSnapshot().conversation.id;
  createInputDrafts(storage).set(id,'message','','An unfinished thought');
  const reopened = createVoiceRuntime({storage});
  assert.equal(reopened.getSnapshot().conversation.id,id);
  assert.equal(createInputDrafts(storage).get(reopened.getSnapshot().conversation.id,'message'),'An unfinished thought');
  assert.equal(reopened.getSnapshot().conversation.lines.length,0);
  const damaged = memory({'hermes.conversations.v2':'unreadable existing data'});
  assert.equal(createVoiceRuntime({storage:damaged}).getSnapshot().state.saved,false);
  assert.equal(damaged.getItem('hermes.conversations.v2'),'unreadable existing data');
});

test('unsent text and individual outline edits survive closing panels and reloading',()=>{
  const storage = memory(); const edits = createInputDrafts(storage);
  edits.set('conversation-a','message','','My unfinished sentence');
  edits.set('conversation-a','outline','person-a','My revised outline');
  edits.set('conversation-a','outline','person-b','Another outline');
  const reopened = createInputDrafts(storage);
  assert.equal(reopened.get('conversation-a','message'),'My unfinished sentence');
  assert.equal(reopened.get('conversation-a','outline','person-a'),'My revised outline');
  assert.equal(reopened.get('conversation-a','outline','person-b'),'Another outline');
  assert.equal(reopened.get('conversation-b','message'),'');
  reopened.clear('conversation-a','message');
  assert.equal(createInputDrafts(storage).get('conversation-a','message'),'');
  assert.equal(reopened.get('conversation-a','outline','person-a'),'My revised outline');
});

test('typed group speech has no implicit speaker and saving failures retain the in-memory draft',()=>{
  const storage = {getItem:()=>null,setItem:()=>{throw new Error('full');}};
  const edits = createInputDrafts(storage);
  assert.equal(edits.get('conversation','message-speaker','','unknown'),'unknown');
  edits.set('conversation','message','','Keep this text');
  assert.equal(edits.get('conversation','message'),'Keep this text');
  assert.match(edits.error,/not been saved/);
});

test('a conversation containing an unsent draft remains reachable after switching modes',async()=>{
  const f = fixture(); const original = f.runtime.getSnapshot().conversation.id;
  await f.runtime.newConversation('group',{keepEmpty:true});
  await f.runtime.selectConversation(original);
  assert.equal(f.runtime.getSnapshot().conversation.id,original);
  assert.equal(f.runtime.getSnapshot().conversation.mode,'solo');
});

test('replaced members remain selectable for their unsaved outline edits',()=>{
  const edits = createInputDrafts(memory());
  let c = newConversation('group'); const previous = c.participantIds[0];
  edits.set(c.id,'outline',previous,'An unsaved revision');
  c = replacePerson(c,previous);
  assert.equal(c.participantIds.includes(previous),false);
  assert.equal(peopleForReview(c,edits).some(p => p.memberId === previous),true);
  assert.equal(edits.get(c.id,'outline',previous),'An unsaved revision');
});

test('a typed question consumes the group request and the next spoken contribution is only recorded',async()=>{
  const f = fixture(); await f.runtime.newConversation('group'); await f.runtime.start();
  for (let i=0;i<3;i++) await f.runtime.enroll();
  const person = participants(f.runtime.getSnapshot().conversation)[0];
  await f.runtime.ask(); assert.equal(f.runtime.getSnapshot().state.engagement,'next');
  await f.runtime.sendText('Can you explain this phrase?',person.memberId);
  assert.equal(f.runtime.getSnapshot().state.engagement,null);
  assert.equal(f.calls.filter(x => x.body?.action === 'respond').length,1);
  f.emit('Now we can compare the two ideas.',{roundId:4,voiceprintId:person.voiceprintId,voiceprintScore:70});
  await tick();
  assert.equal(f.calls.filter(x => x.body?.action === 'respond').length,1);
  assert.match(f.runtime.getSnapshot().conversation.lines.at(-1).text,/compare/);
  await f.runtime.stop();
});
function packet(type,payload) {const text=new TextEncoder().encode(JSON.stringify(payload));const buffer=new ArrayBuffer(8+text.length);new Uint8Array(buffer).set(new TextEncoder().encode(type));new DataView(buffer).setUint32(4,text.length,false);new Uint8Array(buffer).set(text,8);return buffer;}
function fixture(options = {}) {
  const calls=[],engines=[]; let count=0;
  const storage=options.storage ?? memory();
  const events=Object.fromEntries(['onError','onAutoplayFailed','onUserJoined','onUserLeave','onRoomBinaryMessageReceived','onLocalAudioPropertiesReport','onTrackEnded'].map(k=>[k,k]));
  const devices=options.devices ?? [{kind:'audioinput',deviceId:'mic',label:'Microphone'}];
  const rtc={RoomProfileType:{chat:0},MediaType:{AUDIO:1},default:{
    events,enableDevices:async()=>({audio:true}),enumerateAudioCaptureDevices:async()=>devices,
    createEngine:()=>{
      const handlers={};let capturing=null;
      const track=()=>capturing ? {label:devices.find(d=>d.deviceId===capturing)?.label,enabled:true,muted:false,readyState:'live',getSettings:()=>({deviceId:capturing})} : undefined;
      const e={
        on:(name,fn)=>handlers[name]=fn,emit:(name,data)=>handlers[name]?.(data),
        joinRoom:async()=>calls.push({joined:true}),publishStream:async()=>{},
        startAudioCapture:async(deviceId)=>{calls.push({capture:'on',deviceId});capturing=options.captureDeviceOverride ?? deviceId;return track().getSettings();},
        stopAudioCapture:async()=>{calls.push({capture:'off'});capturing=null;},
        setAudioCaptureDevice:async(deviceId)=>{calls.push({selected:deviceId});if(capturing && !options.ignoreDeviceSwitch)capturing=options.captureDeviceOverride ?? deviceId;},
        getLocalStreamTrack:track,
        enableAudioPropertiesReport:config=>calls.push({audioReport:config}),
        setPlaybackVolume:(userId,streamIndex,volume)=>calls.push({playbackVolume:volume,userId,streamIndex}),
        play:async(userId)=>{calls.push({play:userId});if(options.playError)throw options.playError;},leaveRoom:async()=>{},
      };engines.push(e);return e;
    },destroyEngine:()=>calls.push({destroy:true}),
  }};
  let session;
  const fetchFn=async(url,init)=>{
    const body=JSON.parse(init.body);calls.push({url,body});
    if(url==='/api/session'){count++;session={appId:'app',roomId:`r${count}`,userId:`u${count}`,botUserId:`b${count}`,taskId:`t${count}`,rtcToken:'test',expiresAt:Math.floor(Date.now()/1000)+600};return Response.json(session);}
    if(url==='/api/voicechat/start'){if(options.delayStart)await options.delayStart;engines.at(-1).emit(events.onUserJoined,{userInfo:{userId:session.botUserId}});}
    if(url==='/api/voiceprint/register')return Response.json({voiceprintId:`vp_${body.name}`});
    if(options.failUpdate && url==='/api/voicechat/update')return Response.json({error:'TestError: unavailable'},{status:502});
    return Response.json({ok:true});
  };
  const runtime=createVoiceRuntime({storage,fetchFn,loadRtc:async()=>rtc,record:options.record ?? (async({onProgress})=>{onProgress(20);return {audio:'test',deviceId:'mic'};})});
  const emit=(text,extra={})=>engines.at(-1).emit(events.onRoomBinaryMessageReceived,{userId:session.botUserId,message:packet('subv',{data:[{userId:session.userId,roundId:1,sequence:0,text,paragraph:true,...extra}]})});
  return {runtime,calls,emit,storage,engines,session:()=>session};
}

const microphones = [
  {kind:'audioinput',deviceId:'default',groupId:'shared',label:'默认值 - USB microphone'},
  {kind:'audioinput',deviceId:'virtual',groupId:'shared',label:'Steam Streaming Microphone'},
  {kind:'audioinput',deviceId:'physical',groupId:'shared',label:'USB microphone'},
];

test('capture uses the actual default microphone even when a virtual input is listed first',async()=>{
  assert.equal(chooseMicrophone(microphones).deviceId,'default');
  assert.equal(chooseMicrophone(microphones,'virtual').deviceId,'virtual');
  assert.equal(chooseMicrophone(microphones,'unplugged').deviceId,'default');
  const f=fixture({devices:microphones});await f.runtime.start();
  assert.equal(f.calls.find(c=>c.capture==='on').deviceId,'default');
  assert.equal(f.runtime.getSnapshot().state.captureDeviceId,'physical');
  assert.equal(f.engines[0].getLocalStreamTrack().getSettings().deviceId,'physical');
  assert(f.calls.findIndex(c=>c.capture==='on') < f.calls.findIndex(c=>c.joined));
  await f.runtime.selectMicrophone('virtual');await f.runtime.toggleMute();await f.runtime.toggleMute();
  assert.equal(f.calls.filter(c=>c.capture==='on').at(-1).deviceId,'virtual');
  await f.runtime.stop();await f.runtime.start();
  assert.equal(f.calls.filter(c=>c.capture==='on').at(-1).deviceId,'virtual');await f.runtime.stop();
});

test('ambiguous device groups never override the device identified by the live track',()=>{
  assert.equal(capturedMicrophone(microphones,{deviceId:'default'},{label:'默认值 - USB microphone'}).deviceId,'physical');
  assert.equal(capturedMicrophone(microphones,{deviceId:'virtual'},{label:'Steam Streaming Microphone'}).deviceId,'virtual');
  assert.throws(()=>capturedMicrophone(microphones,{deviceId:'default'},{label:'Unknown microphone'}),/could not be identified/);
});

test('an ignored microphone switch fails before publishing or starting the voice service',async()=>{
  const f=fixture({devices:microphones,ignoreDeviceSwitch:true});await f.runtime.start();
  assert.equal(f.runtime.getSnapshot().state.phase,'idle');assert.match(f.runtime.getSnapshot().state.error,/did not switch/);
  assert.equal(f.calls.some(c=>c.joined || c.url==='/api/voicechat/start'),false);
  assert(f.calls.some(c=>c.capture==='off'));
});

test('group registration and reconnect use the verified physical microphone behind the alias',async()=>{
  const f=fixture({devices:microphones,record:async({deviceId})=>({deviceId,audio:'test'})});
  await f.runtime.newConversation('group');await f.runtime.start();
  for(let i=0;i<3;i++)await f.runtime.enroll();
  assert.equal(f.runtime.getSnapshot().state.phase,'listening');
  assert(participants(f.runtime.getSnapshot().conversation).every(p=>p.deviceId==='physical'));
  await f.runtime.stop();await f.runtime.start();
  assert.equal(f.calls.filter(c=>c.url==='/api/voicechat/start').at(-1).body.mode,'group');await f.runtime.stop();
});

test('real microphone levels drive feedback, mute clears it, and a lost track ends the call',async()=>{
  const f=fixture();await f.runtime.start();const engine=f.engines[0];
  assert.equal(f.runtime.getSnapshot().state.hasInput,false);
  engine.emit('onLocalAudioPropertiesReport',[{streamIndex:0,audioPropertiesInfo:{linearVolume:130}}]);
  assert.equal(f.runtime.getSnapshot().state.inputLevel,130);assert.equal(f.runtime.getSnapshot().state.hasInput,true);
  await f.runtime.toggleMute();engine.emit('onLocalAudioPropertiesReport',[{streamIndex:0,audioPropertiesInfo:{linearVolume:100}}]);
  assert.equal(f.runtime.getSnapshot().state.inputLevel,0);
  await f.runtime.toggleMute();engine.emit('onTrackEnded',{kind:'audio',isScreen:false});await tick();
  assert.equal(f.runtime.getSnapshot().state.phase,'idle');assert.match(f.runtime.getSnapshot().state.error,/Microphone disconnected/);
});

test('resuming sound uses the RTC player and preserves a failed playback prompt',async()=>{
  const options={playError:new Error('Playback blocked')};const f=fixture(options);await f.runtime.start();
  f.engines[0].emit('onAutoplayFailed');await f.runtime.enableSound();
  assert.equal(f.runtime.getSnapshot().state.autoplayBlocked,true);
  options.playError=null;await f.runtime.enableSound();
  assert.equal(f.calls.filter(c=>c.play).at(-1).play,f.session().botUserId);
  assert.equal(f.runtime.getSnapshot().state.autoplayBlocked,false);await f.runtime.stop();
});
test('solo bypasses enrollment; group waits for all three registrations',()=>{
  const solo=newConversation();const group=newConversation('group');
  const request=buildHermesVoiceChatRequest({mode:'solo',members:participants(solo)});
  assert.deepEqual(request.AgentConfig.VoicePrint,{Mode:0});assert.equal(request.Config.ASRConfig.TurnDetectionMode,0);
  assert.equal(request.Config.LLMConfig.AutoActive,true);
  assert.equal(buildHermesVoiceChatRequest({mode:'enrollment',members:participants(group)}).Config.LLMConfig.AutoActive,false);
  assert.throws(()=>buildHermesVoiceChatRequest({mode:'group',members:participants(group)}),/register/);
  assert.equal(buildHermesVoiceChatRequest({mode:'enrollment',members:participants(group)}).AgentConfig.VoicePrint.Mode,0);
});
test('replacing and renaming people never reassigns old records',()=>{
  let c=newConversation('group');const old=c.participantIds[0];
  c=updatePerson(c,old,{name:'甲'});c=addText(c,'My own idea.',old);c=replacePerson(c,old);
  c=updatePerson(c,c.participantIds[0],{name:'乙'});
  assert.equal(c.lines[0].speakerId,old);assert.equal(personName(c,c.lines[0].speakerId),'甲');
  assert.notEqual(c.participantIds[0],old);assert.equal(c.people.length,4);
});
test('corrections survive late ASR and invalidate affected outlines',()=>{
  let c=newConversation('group');const [a,b]=c.participantIds;
  c=updatePerson(c,a,{voiceprintId:'vp_a'});
  const session={taskId:'t',botUserId:'bot'};
  const speech={userId:'user',roundId:1,sequence:1,text:'Tea',paragraph:false,voiceprintId:'vp_a',voiceprintScore:70};
  c=receiveSubtitle(c,speech,session);const key=c.lines[0].key;
  c=saveDraft(saveDraft(c,a,'A'),b,'B');
  c=correctText(correctAttribution(c,key,b),key,'Correct meaning.');
  c=receiveSubtitle(c,{...speech,sequence:2,paragraph:true,text:'Wrong ASR'},session);
  assert.equal(c.lines[0].text,'Correct meaning.');assert.equal(c.lines[0].speakerId,b);
  assert.equal(c.drafts[a].status,'needs_review');assert.equal(c.drafts[b].status,'needs_review');
  const context=JSON.parse(conversationContext(c));assert.equal(context.records[0].personId,b);assert.equal(context.records[0].text,'Correct meaning.');
});
test('manual ASR segments in one round are preserved and deduplicated',()=>{
  let c=newConversation(); const session={taskId:'t',botUserId:'bot'};
  const speech=(sequence,text,paragraph)=>({userId:'u',roundId:1,sequence,text,paragraph});
  for(const data of [speech(0,'First',false),speech(1,'First.',true),speech(2,'Second',false),speech(3,'Second.',true),speech(3,'Second.',true)])c=receiveSubtitle(c,data,session);
  assert.deepEqual(c.lines.map(l=>l.text),['First.','Second.']);assert(c.lines.every(l=>l.speakerId===c.participantIds[0]));
});
test('group questions get one reply and ordinary discussion resumes without a mode switch',()=>{
  assert.equal(responseDecision('group','I think so.','a',null).action,'record');
  assert.equal(responseDecision('group','Mimi, can you help?','a',null).action,'respond');
  assert.equal(responseDecision('group','Because it matters.','a','a').action,'record');
  const question = responseDecision('group','Mimi, can you help?','a',null);
  assert.equal(question.engagement,null);
  assert.equal(responseDecision('group','Because it matters.','a',question.engagement).action,'record');
  const buttonQuestion = responseDecision('group','Can you help with this?','b','next');
  assert.equal(buttonQuestion.action,'respond'); assert.equal(buttonQuestion.engagement,null);
  assert.equal(responseDecision('group','I disagree.','b','a').action,'record');
  assert.equal(responseDecision('solo','先听我说','a','next').action,'listen');
  assert.equal(responseDecision('solo','My story.','a',null).action,'record');
  const unknown = responseDecision('group','Mimi, help me.',null,null);
  assert.equal(unknown.action,'respond');
  assert.equal(responseDecision('group','A different person speaking.',null,unknown.engagement).action,'record');
});
test('migration preserves old storage and assigns durable member ids',()=>{
  const members=[1,2,3].map(i=>({memberId:`speaker_${i}`,name:`Person ${i}`,voiceprintId:`vp${i}`}));
  const old=JSON.stringify({version:1,members,lines:[{text:'Saved idea',speakerId:'speaker_2'}]});
  const storage=memory({'hermes.group.v1':old});const w=readWorkspace(storage);
  assert.equal(w.conversations[0].lines[0].speakerId,w.conversations[0].people[1].memberId);
  assert.equal(storage.getItem('hermes.group.v1'),old);
});
test('solo lifecycle routes once, listen-only records, and restarts with prior context',async()=>{
  const f=fixture();await f.runtime.start();assert.equal(f.runtime.getSnapshot().state.phase,'listening');
  f.emit('My case concerns tea.');f.emit('My case concerns tea.');await tick();
  assert.equal(f.calls.filter(x=>x.body?.action==='respond').length,1);
  await f.runtime.listenOnly();f.emit('Let me add another point.',{roundId:2});await tick();
  assert.equal(f.calls.filter(x=>x.body?.action==='respond').length,1);assert.equal(f.runtime.getSnapshot().conversation.lines.length,2);
  await f.runtime.stop();await f.runtime.start();
  const request=f.calls.filter(x=>x.url==='/api/voicechat/start').at(-1).body;
  assert.match(request.context,/Let me add another point/);assert.equal(request.mode,'solo');await f.runtime.stop();
});
test('cancelling during Start waits then stops the same service task',async()=>{
  let resolve;const delayStart=new Promise(r=>resolve=r);const f=fixture({delayStart});
  const started=f.runtime.start();await tick();
  const stopped=f.runtime.stop();resolve();await Promise.all([started,stopped]);
  const service=f.calls.filter(x=>x.url?.includes('voicechat')).map(x=>x.url);
  assert.deepEqual(service,['/api/voicechat/start','/api/voicechat/stop']);assert.equal(f.runtime.getSnapshot().state.phase,'idle');
});
test('group enrollment keeps successful people and restarts in recognition mode',async()=>{
  const f=fixture();await f.runtime.newConversation('group');await f.runtime.start();
  assert.equal(f.runtime.getSnapshot().state.phase,'enrolling');
  for(let i=0;i<3;i++)await f.runtime.enroll();
  assert.equal(f.runtime.getSnapshot().state.phase,'listening');assert(participants(f.runtime.getSnapshot().conversation).every(p=>p.voiceprintId));
  const requests=f.calls.filter(x=>x.url==='/api/voicechat/start');assert.deepEqual(requests.map(x=>x.body.mode),['enrollment','group']);
  const [a,b]=participants(f.runtime.getSnapshot().conversation);
  f.emit('We should discuss it.',{voiceprintId:a.voiceprintId,voiceprintScore:70});await tick();
  assert.equal(f.calls.filter(x=>x.body?.action==='respond').length,0);
  f.emit('Mimi, is my wording clear?',{roundId:2,voiceprintId:b.voiceprintId,voiceprintScore:70});await tick();
  assert.equal(f.calls.filter(x=>x.body?.action==='respond').length,1);await f.runtime.stop();
});
test('a failed registration leaves previous registration and permits retry',async()=>{
  let n=0;const f=fixture({record:async()=>{if(++n===2)throw new Error('Recording failed');return {audio:'test',deviceId:'mic'};}});
  await f.runtime.newConversation('group');await f.runtime.start();await f.runtime.enroll();const first=participants(f.runtime.getSnapshot().conversation)[0];await f.runtime.enroll();
  assert.equal(participants(f.runtime.getSnapshot().conversation)[0].voiceprintId,first.voiceprintId);assert.equal(f.runtime.getSnapshot().state.phase,'enrolling');
  await f.runtime.enroll();assert.equal(participants(f.runtime.getSnapshot().conversation).filter(p=>p.voiceprintId).length,2);await f.runtime.stop();
});
test('mode switching and reloading keep earlier conversations',async()=>{
  const f=fixture();await f.runtime.rename(f.runtime.getSnapshot().conversation.participantIds[0],'本人');const original=f.runtime.getSnapshot().conversation.id;
  await f.runtime.newConversation('group');assert.equal(f.runtime.getSnapshot().workspace.conversations.length,2);
  await f.runtime.selectConversation(original);const restored=readWorkspace(f.storage);assert.equal(restored.currentId,original);assert.equal(restored.conversations[0].people[0].name,'本人');
});
test('server updates corrected context before triggering a reply; failure prevents trigger',async()=>{
  const ids={roomId:'r',taskId:'t',userId:'u',botUserId:'b'};
  const body={...ids,action:'respond',context:'{"revision":2}',text:'Hello.'};
  assert.deepEqual(buildVoiceUpdates(body,'a',ids).map(x=>x.Command),['UpdateParameters','ExternalTextToLLM']);
  const env={VOLC_ACCESS_KEY_ID:'test',VOLC_SECRET_ACCESS_KEY:'test',VOLC_RTC_APP_ID:'a'.repeat(24),VOLC_RTC_APP_KEY:'test',DB:testDatabase()};
  body.configTicket=await signTicket({purpose:'voice-config',taskId:ids.taskId,roomId:ids.roomId,revision:0,expiresAt:Date.now()+60000},env.VOLC_RTC_APP_KEY);
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{calls.push(JSON.parse(init.body));return Response.json({ResponseMetadata:{Error:{Code:'TestError',Message:'Unavailable'}}},{status:502});};
  try { await assert.rejects(handleRequest(new Request('http://localhost/api/voicechat/update',{method:'POST',body:JSON.stringify(body)}),env));assert.equal(calls.length,1);assert.equal(calls[0].Command,'UpdateParameters'); }
  finally {globalThis.fetch=original;}
});

test('automatic ASR completes, but only the app-requested reply round becomes audible',async()=>{
  const f=fixture();await f.runtime.start();
  f.emit('Can you hear',{sequence:10,definite:false,paragraph:false});
  assert.equal(f.calls.some(c=>c.body?.action==='respond'),false);
  f.emit('Can you hear me?',{sequence:11,definite:true,paragraph:true});
  f.emit('Automatic response before corrected context.',{userId:f.session().botUserId,roundId:1});
  assert.equal(f.runtime.getSnapshot().conversation.lines.length,1);
  assert.equal(f.calls.filter(c=>c.playbackVolume!==undefined).at(-1).playbackVolume,0);
  await tick();
  assert.deepEqual(f.calls.filter(c=>c.url==='/api/voicechat/update').map(c=>c.body.action),['interrupt','respond']);
  f.emit('Yes, I can hear you.',{userId:f.session().botUserId,roundId:2});
  assert.equal(f.runtime.getSnapshot().conversation.lines.at(-1).text,'Yes, I can hear you.');
  assert.equal(f.calls.filter(c=>c.playbackVolume!==undefined).at(-1).playbackVolume,100);
  await f.runtime.listenOnly();
  f.emit('A late answer.',{userId:f.session().botUserId,roundId:2,sequence:20});
  f.emit('Let me finish.',{roundId:3});await tick();
  assert.equal(f.calls.filter(c=>c.body?.action==='respond').length,1);
  assert.equal(f.calls.filter(c=>c.playbackVolume!==undefined).at(-1).playbackVolume,0);
  assert(!f.runtime.getSnapshot().conversation.lines.some(l=>l.text.includes('late answer')));
  await f.runtime.stop();
});

test('a failed context or interrupt request never unmutes an automatic model reply',async()=>{
  const f=fixture({failUpdate:true});await f.runtime.start();
  f.emit('Please help me.');await tick();
  f.emit('An unrequested answer.',{userId:f.session().botUserId,roundId:1});
  assert.equal(f.calls.some(c=>c.playbackVolume===100),false);
  assert.equal(f.runtime.getSnapshot().conversation.lines.length,1);
  assert.match(f.runtime.getSnapshot().state.error,/unavailable/);await f.runtime.stop();
});

test('an outline is stored for its requested person, then invalidated by a correction',async()=>{
  const f=fixture();await f.runtime.start();const person=f.runtime.getSnapshot().conversation.participantIds[0];
  f.emit('My topic is tea.');await tick();await f.runtime.listenOnly();
  await f.runtime.outline(person);
  f.emit('What happened: Tea travelled west.',{userId:f.session().botUserId,roundId:2,sequence:0,paragraph:false});
  f.emit('',{userId:f.session().botUserId,roundId:2,sequence:1,paragraph:true});
  assert.match(f.runtime.getSnapshot().conversation.drafts[person].text,/Tea travelled west/);
  const key=f.runtime.getSnapshot().conversation.lines[0].key;
  await f.runtime.correct(key,person,'My topic is pottery.');
  assert.equal(f.runtime.getSnapshot().conversation.drafts[person].status,'needs_review');
  const update=f.calls.filter(x=>x.body?.action==='context').at(-1);
  assert.match(update.body.context,/My topic is pottery/);await f.runtime.stop();
});

test('standalone Worker tokens use the official length-prefixed base64 envelope and valid signature',async()=>{
  const env={VOLC_ACCESS_KEY_ID:'test',VOLC_SECRET_ACCESS_KEY:'test',VOLC_RTC_APP_ID:'a'.repeat(24),VOLC_RTC_APP_KEY:'test-key'};
  const response=await handleRequest(new Request('http://localhost/api/session',{method:'POST'}),env);
  const session=await response.json();assert.equal(session.rtcToken.slice(0,27),'001'+'a'.repeat(24));
  const content=Buffer.from(session.rtcToken.slice(27),'base64');
  const length=content.readUInt16LE(0);const message=content.subarray(2,2+length);
  const sigLength=content.readUInt16LE(2+length);const signature=content.subarray(4+length);
  assert.equal(sigLength,32);assert.equal(signature.length,32);assert.deepEqual(signature,createHmac('sha256','test-key').update(message).digest());
  const roomLength=message.readUInt16LE(12);assert.equal(message.subarray(14,14+roomLength).toString(),session.roomId);
  assert.equal(message.readUInt32LE(8),session.expiresAt);
});
