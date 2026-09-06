import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { newConversation, participants, updatePerson, replacePerson, addText, saveDraft, correctAttribution, correctText, receiveSubtitle, readWorkspace, conversationContext, responseDecision, personName } from '../../hermes-volc-standalone/public/conversation.js';
import { createVoiceRuntime, chooseMicrophone, capturedMicrophone } from '../../hermes-volc-standalone/public/voice-runtime.js';
import { buildHermesVoiceChatRequest, buildVoiceUpdates } from '../../hermes-volc-standalone/public/voice-chat-config.js';
import { handleRequest } from '../../hermes-volc-standalone/worker.js';
import { createInputDrafts } from '../../hermes-volc-standalone/public/input-drafts.js';
import { peopleForReview, renderSoloEnrollment } from '../../hermes-volc-standalone/public/coach-view.js';
import { hasConfirmedVoice, acceptSoloSubtitle, approveSoloRound } from '../../hermes-volc-standalone/public/solo-voice.js';
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
  // Turn-taking tests begin with a previously click-confirmed owner. Enrollment
  // tests explicitly start without this saved voice and exercise the real gate.
  if (!options.storage && options.withVoice !== false) {
    let c=newConversation(); c=updatePerson(c,c.participantIds[0],{voiceprintId:options.voiceprintId ?? 'owner_voice',voiceConfirmed:true,voiceprintVersion:2,deviceId:options.devices ? 'physical' : 'mic'});
    storage.setItem('hermes.conversations.v2',JSON.stringify({version:2,currentId:c.id,conversations:[c]}));
  }
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
    if(url==='/api/voicechat/start'){if(options.delayStart)await options.delayStart;engines.at(-1).emit(events.onUserJoined,{userInfo:{userId:session.botUserId}});if(body.mode==='solo' && options.activeStatus!==false)engines.at(-1).emit(events.onRoomBinaryMessageReceived,{userId:session.botUserId,message:packet('stat',{event:'VoicePrintStatus',status:'Active'})});}
    if(url==='/api/voiceprint/register')return Response.json({voiceprintId:`vp_${body.name}`});
    if(options.failUpdate && url==='/api/voicechat/update')return Response.json({error:'TestError: unavailable'},{status:502});
    return Response.json({ok:true});
  };
  const runtime=createVoiceRuntime({storage,fetchFn,loadRtc:async()=>rtc,record:options.record ?? (async({onProgress})=>{onProgress(20);return {audio:'test',deviceId:'mic'};})});
  const event=(type,value,userId=session.botUserId)=>engines.at(-1).emit(events.onRoomBinaryMessageReceived,{userId,message:packet(type,value)});
  const think=(roundId=1,extra={},sender)=>event('conv',{Stage:{Code:2,Description:'thinking'},RoundID:roundId,TaskId:session.taskId,UserID:session.userId,...extra},sender);
  const emit=(text,extra={})=>{
    const data={userId:session.userId,roundId:1,sequence:0,text,paragraph:true,...(options.autoIdentity===true || (options.autoIdentity!==false && runtime.getSnapshot().conversation.mode==='group') ? {voiceprintId:participants(runtime.getSnapshot().conversation)[0]?.voiceprintId,voiceprintScore:75} : {}),...extra};
    event('subv',{data:[data]});
    if(options.autoApproval!==false && data.paragraph && data.userId===session.userId && runtime.getSnapshot().conversation.mode==='solo')think(data.roundId);
  };
  const status=value=>engines.at(-1).emit(events.onRoomBinaryMessageReceived,{userId:session.botUserId,message:packet('stat',{event:'VoicePrintStatus',status:value})});
  return {runtime,calls,emit,status,think,event,storage,engines,session:()=>session};
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
  await f.runtime.selectMicrophone('virtual');
  assert.equal(f.runtime.getSnapshot().state.phase,'idle');
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
test('solo requires a click-confirmed voice and enables separation plus verification; group retains recognition',()=>{
  const solo=newConversation();const group=newConversation('group');
  assert.throws(()=>buildHermesVoiceChatRequest({mode:'solo',members:participants(solo)}),/Confirm your voice/);
  const owner={...participants(solo)[0],voiceConfirmed:true,voiceprintVersion:2,voiceprintId:'mine'};
  const request=buildHermesVoiceChatRequest({mode:'solo',members:[owner]});
  assert.deepEqual(request.AgentConfig.VoicePrint,{Mode:1,IdList:['mine'],EnableSV:true,Score:50,ProcessMode:2,SVMode:2});assert.equal(request.Config.ASRConfig.TurnDetectionMode,0);
  assert.equal(request.Config.LLMConfig.AutoActive,true);
  assert.equal(JSON.parse(request.Config.ASRConfig.ProviderParams.VolcanoASRParameters).request.enable_nonstream,false);
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
  let c=newConversation(); c=updatePerson(c,c.participantIds[0],{voiceprintId:'owner'}); const session={taskId:'t',botUserId:'bot'};
  const speech=(sequence,text,paragraph)=>({userId:'u',roundId:1,sequence,text,paragraph,verifiedVoiceprintId:'owner',voiceVerification:'volcengine-mode1',voiceVerified:true});
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

test('solo enrollment waits for a click, registers precisely the reviewed sample, and then enables protection',async()=>{
  let f;
  const audio=Buffer.from('the reviewed recording').toString('base64');
  f=fixture({withVoice:false,record:async({deviceId,track,onProgress})=>{
    assert.equal(track.getSettings().deviceId,deviceId); onProgress(20);
    f.emit('My name is Lin. I would like to discuss tea.');
    return {audio,deviceId};
  }});
  await f.runtime.start(); await tick();
  assert.equal(f.runtime.getSnapshot().state.phase,'review-voice');
  assert.match(f.runtime.getSnapshot().state.intro,/My name is Lin/);
  assert.equal(f.calls.filter(c=>c.url==='/api/voiceprint/register').length,0);
  assert.equal(f.runtime.getSnapshot().conversation.lines.length,0);
  f.emit('Yes, that was me.',{roundId:2}); await tick();
  assert.equal(f.runtime.getSnapshot().state.phase,'review-voice');
  assert.equal(f.calls.filter(c=>c.url==='/api/voiceprint/register').length,0);
  await Promise.all([f.runtime.confirmVoice(),f.runtime.confirmVoice()]);
  assert.equal(f.calls.filter(c=>c.url==='/api/voiceprint/register').length,1);
  assert.equal(f.calls.find(c=>c.url==='/api/voiceprint/register').body.audio,audio);
  assert.equal(f.runtime.getSnapshot().state.phase,'listening');
  assert.equal(f.runtime.getSnapshot().state.voiceProtection,'active');
  assert.equal(f.runtime.getSnapshot().conversation.lines.length,0);
  assert(hasConfirmedVoice(participants(f.runtime.getSnapshot().conversation)[0],'mic'));
  f.emit('Now I am ready to talk.',{roundId:3}); await tick();
  assert.equal(f.runtime.getSnapshot().conversation.lines.length,1);
  assert.equal(f.calls.filter(c=>c.body?.action==='respond').length,1);
  await f.runtime.stop();
});

test('rejecting a recording discards its words and audio; only the next clicked sample is registered',async()=>{
  let f,n=0;
  f=fixture({withVoice:false,record:async({deviceId})=>{ n++; f.emit(n===1 ? 'Someone else is speaking.' : 'These are my own words.',{roundId:n}); return {deviceId,audio:Buffer.from(`sample${n}`).toString('base64')}; }});
  await f.runtime.start(); await tick(); await f.runtime.cancelEnrollment();
  await f.runtime.confirmVoice();
  assert.equal(f.calls.some(c=>c.url==='/api/voiceprint/register'),false);
  assert.equal(f.runtime.getSnapshot().state.sampleUrl,'');
  await f.runtime.start(); await tick(); await f.runtime.confirmVoice();
  assert.equal(Buffer.from(f.calls.find(c=>c.url==='/api/voiceprint/register').body.audio,'base64').toString(),'sample2');
  assert(!JSON.stringify(f.runtime.getSnapshot().workspace).includes('Someone else'));
  await f.runtime.stop();
});

test('unmatched speech cannot write records, ask Mimi, pause replies, or interrupt the current reply',async()=>{
  const f=fixture({autoIdentity:false}); await f.runtime.start();
  f.emit('My question.',{voiceprintId:'owner_voice',voiceprintScore:80}); await tick();
  f.emit('Mimi, answer my question.',{roundId:2,voiceprintId:'neighbour',voiceprintScore:99});
  f.emit('Just listen.',{roundId:3,voiceprintId:'owner_voice',voiceprintScore:10});
  f.event('stat',{event:'VoiceReject',reason:'VoicePrintNotMatch',text:'Yes.'}); await tick();
  assert.equal(f.runtime.getSnapshot().conversation.lines.length,1);
  assert.equal(f.calls.filter(c=>c.body?.action==='respond').length,1);
  assert.equal(f.runtime.getSnapshot().state.phase,'thinking');
  assert.equal(f.runtime.getSnapshot().state.engagement,f.runtime.getSnapshot().conversation.participantIds[0]);
  assert(!f.calls.some(c=>c.body?.text?.includes('answer my question')));
  assert(!conversationContext(f.runtime.getSnapshot().conversation).includes('Just listen'));
  await f.runtime.stop();
});

test('solo keeps partial speech outside records and rejects mixed identities in one utterance',async()=>{
  const f=fixture({autoIdentity:false}); await f.runtime.start();
  f.emit('My idea',{sequence:0,paragraph:false,voiceprintId:'owner_voice',voiceprintScore:80});
  assert.equal(f.runtime.getSnapshot().conversation.lines.length,0);
  f.emit('My idea and a neighbour’s words.',{sequence:1,voiceprintId:'neighbour',voiceprintScore:90}); await tick();
  assert.equal(f.runtime.getSnapshot().conversation.lines.length,0);
  f.emit('Only my next sentence.',{roundId:2,sequence:2,voiceprintId:'owner_voice',voiceprintScore:80,paragraph:false});
  f.emit('',{roundId:2,sequence:3}); await tick();
  assert.equal(f.runtime.getSnapshot().conversation.lines[0].text,'Only my next sentence.');
  assert.equal(f.calls.filter(c=>c.body?.action==='respond').length,1);
  await f.runtime.stop();
});

test('voice protection must become active before records are accepted and loss of protection stops capture',async()=>{
  const f=fixture({activeStatus:false}); const starting=f.runtime.start(); await tick();
  f.emit('Mimi, speak before verification.');
  assert.equal(f.runtime.getSnapshot().conversation.lines.length,0);
  assert.equal(f.runtime.getSnapshot().state.phase,'connecting');
  f.status('Active'); await starting;
  f.emit('My verified words.'); await tick();
  f.status('Failed'); await tick();
  assert.equal(f.runtime.getSnapshot().state.phase,'idle');
  assert.match(f.runtime.getSnapshot().state.error,/Voice protection is unavailable/);
  assert(f.calls.some(c=>c.capture==='off'));
});

test('25 separate solo sessions never adopt the neighbouring session’s voice',async()=>{
  const students=Array.from({length:25},(_,i)=>fixture({voiceprintId:`voice_${i}`,autoIdentity:false}));
  try {
    await Promise.all(students.map(f=>f.runtime.start()));
    students.forEach((f,i)=>{
      f.emit('This belongs to the neighbour.',{voiceprintId:`voice_${(i+1)%25}`,voiceprintScore:99});
      f.emit(`My own contribution ${i}.`,{roundId:2,voiceprintId:`voice_${i}`,voiceprintScore:80});
    });
    await tick();
    students.forEach((f,i)=>{
      assert.deepEqual(f.runtime.getSnapshot().conversation.lines.map(l=>l.text),[`My own contribution ${i}.`]);
      assert.equal(f.calls.filter(c=>c.body?.action==='respond').length,1);
    });
  } finally { await Promise.all(students.map(f=>f.runtime.stop())); }
});

test('voice confirmation uses click controls and safely displays the captured words',()=>{
  const html=renderSoloEnrollment({phase:'review-voice',intro:'<script>not markup</script>',sampleUrl:'blob:test'});
  assert.match(html,/Is this what you just said\?/);
  assert.match(html,/data-action="confirm-voice"/); assert.match(html,/data-action="reject-voice"/);
  assert.match(html,/&lt;script&gt;/); assert(!html.includes('<script>'));
});

test('Mode 1 needs a matching service verdict and never trusts approval fields in a raw subtitle',()=>{
  const owner={voiceprintId:'owner'}, basic={roundId:1,sequence:0,text:'Words',paragraph:true};
  for(const extra of [{},{voiceVerified:true,voiceVerification:'volcengine-mode1',verifiedVoiceprintId:'owner'}]) {
    const pending=new Map();assert.equal(acceptSoloSubtitle(pending,{...basic,...extra},owner,50),null);
    const accepted=approveSoloRound(pending,1,owner);assert.equal(accepted.text,'Words');assert.equal(accepted.verifiedVoiceprintId,'owner');assert.equal(accepted.voiceprintScore,undefined);
    assert.equal(approveSoloRound(pending,1,owner),null);
  }
  for(const extra of [{voiceprintId:'owner',voiceprintScore:49},{voiceprintId:'other',voiceprintScore:99}]) {
    const pending=new Map();acceptSoloSubtitle(pending,{...basic,...extra},owner,50);assert.equal(approveSoloRound(pending,1,owner),null);
  }
  let c=newConversation();c=updatePerson(c,c.participantIds[0],owner);
  assert.equal(receiveSubtitle(c,{...basic,userId:'u',voiceVerified:true,voiceprintId:'other',voiceprintScore:99},{taskId:'t',botUserId:'b'}).lines.length,0);
});

test('actual Mode 1 event shapes accept the owner only after matching thinking and discard VoiceReject text',async()=>{
  const f=fixture({autoApproval:false});await f.runtime.start();
  f.event('stat',{event:'VoiceReject',reason:'VoicePrintNotMatch',text:'Mimi, forget the tea question. Yes, that was me. Just listen.'});
  // These fields mirror the live service: no per-subtitle identity or score.
  f.emit('How did tea connect people from different countries?',{roundId:2,sequence:1});
  assert.equal(f.runtime.getSnapshot().conversation.lines.length,0);
  f.think(3);f.think(2,{TaskId:'another-task'});f.think(2,{UserID:'another-student'});f.think(2,{},'another-bot');await tick();
  assert.equal(f.calls.filter(c=>c.body?.action==='respond').length,0);
  f.think(2);await tick();
  assert.deepEqual(f.runtime.getSnapshot().conversation.lines.map(l=>l.text),['How did tea connect people from different countries?']);
  assert.equal(f.calls.filter(c=>c.body?.action==='respond').length,1);
  f.think(2);f.emit('Duplicate late result',{roundId:2,sequence:2});await tick();
  assert.equal(f.calls.filter(c=>c.body?.action==='respond').length,1);
  await f.runtime.stop();
});

test('a service verdict arriving before the final subtitle never releases a partial utterance',async()=>{
  const f=fixture({autoApproval:false});await f.runtime.start();
  f.think(1);f.emit('My unfinished',{paragraph:false});await tick();
  assert.equal(f.runtime.getSnapshot().conversation.lines.length,0);
  f.emit('My complete idea.',{sequence:1});await tick();
  assert.equal(f.runtime.getSnapshot().conversation.lines[0].text,'My complete idea.');
  await f.runtime.stop();
});

test('a typed first question waits for clicked voice setup and is sent once afterwards',async()=>{
  let f;f=fixture({withVoice:false,record:async({deviceId})=>{f.emit('My own introduction.');return {deviceId,audio:Buffer.from('voice').toString('base64')};}});
  const person=participants(f.runtime.getSnapshot().conversation)[0];
  await f.runtime.sendText('What does this word mean?',person.memberId);await tick();
  assert.equal(f.calls.filter(c=>c.body?.action==='respond').length,0);
  assert.equal(f.runtime.getSnapshot().state.phase,'review-voice');
  await f.runtime.confirmVoice();await tick();
  assert.equal(f.calls.filter(c=>c.body?.action==='respond').length,1);
  assert.match(f.calls.find(c=>c.body?.action==='respond').body.text,/What does this word mean/);
  await f.runtime.stop();
});

test('reopening a confirmed solo conversation reuses its voice; a legacy unconfirmed voice must be confirmed',async()=>{
  const first=fixture();await first.runtime.start();first.emit('My earlier contribution.');await tick();await first.runtime.stop();
  const reopened=fixture({storage:first.storage});await reopened.runtime.start();
  assert.equal(reopened.calls.find(c=>c.url==='/api/voicechat/start').body.members[0].voiceprintId,'owner_voice');
  assert.equal(reopened.calls.some(c=>c.url==='/api/voiceprint/register'),false);
  assert.equal(reopened.runtime.getSnapshot().conversation.lines[0].text,'My earlier contribution.');
  await reopened.runtime.stop();
  const saved=JSON.parse(first.storage.getItem('hermes.conversations.v2'));
  delete saved.conversations[0].people[0].voiceConfirmed;
  first.storage.setItem('hermes.conversations.v2',JSON.stringify(saved));
  let legacy;legacy=fixture({storage:first.storage,record:async({deviceId})=>{legacy.emit('Please learn my voice again.');return {deviceId,audio:Buffer.from('legacy recheck').toString('base64')};}});
  await legacy.runtime.start();await tick();
  assert.equal(legacy.calls.find(c=>c.url==='/api/voicechat/start').body.mode,'enrollment');
  assert.equal(legacy.runtime.getSnapshot().state.phase,'review-voice');
  assert.equal(legacy.calls.some(c=>c.url==='/api/voiceprint/register'),false);
  await legacy.runtime.stop();
});

test('a new solo conversation starts with a new person and cannot inherit the preceding student’s voice or context',async()=>{
  let f;f=fixture({record:async({deviceId})=>{f.emit('This is the new student.');return {deviceId,audio:Buffer.from('new person').toString('base64')};}});
  await f.runtime.start();f.emit('The first student’s private practice.');await tick();await f.runtime.stop();
  const previous=f.runtime.getSnapshot().conversation;
  await f.runtime.newConversation('solo');await f.runtime.start();await tick();
  const next=f.runtime.getSnapshot().conversation;
  assert.notEqual(next.participantIds[0],previous.participantIds[0]);
  assert.equal(participants(next)[0].voiceprintId,'');
  assert.equal(next.lines.length,0);
  const start=f.calls.filter(c=>c.url==='/api/voicechat/start').at(-1).body;
  assert.equal(start.mode,'enrollment');assert(!start.context.includes('private practice'));
  assert.equal(f.runtime.getSnapshot().workspace.conversations.find(c=>c.id===previous.id).lines[0].text,'The first student’s private practice.');
  await f.runtime.stop();
});

test('changing microphones requires a new clicked sample and ignores delayed events from the old microphone’s call',async()=>{
  let f;f=fixture({devices:[{kind:'audioinput',deviceId:'physical',label:'Original microphone'},{kind:'audioinput',deviceId:'other',label:'New microphone'}],record:async({deviceId,track})=>{assert.equal(track.getSettings().deviceId,'other');f.emit('This is me on the new microphone.');return {deviceId,audio:Buffer.from('new microphone').toString('base64')};}});
  await f.runtime.start();const oldEngine=f.engines[0],oldSession=f.session();
  await f.runtime.selectMicrophone('other');assert.equal(f.runtime.getSnapshot().state.phase,'idle');
  await f.runtime.start();await tick();
  oldEngine.emit('onRoomBinaryMessageReceived',{userId:oldSession.botUserId,message:packet('subv',{data:[{userId:oldSession.userId,roundId:1,sequence:0,text:'Old microphone words.',paragraph:true}]})});
  assert.equal(f.runtime.getSnapshot().state.phase,'review-voice');
  assert.equal(f.runtime.getSnapshot().state.intro,'This is me on the new microphone.');
  assert.equal(f.calls.some(c=>c.url==='/api/voiceprint/register'),false);
  await f.runtime.confirmVoice();
  assert(hasConfirmedVoice(participants(f.runtime.getSnapshot().conversation)[0],'other'));
  assert.equal(f.runtime.getSnapshot().conversation.lines.length,0);
  await f.runtime.stop();
});
