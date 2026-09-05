import { WORKSPACE_KEY, newWorkspace, newConversation, readWorkspace, participants, personName, updatePerson, replacePerson, receiveSubtitle, responseDecision, conversationContext, extractIntroducedName, correctAttribution, correctText, addText, saveDraft } from './conversation.js';
import { recordVoiceSample } from './voice-enrollment.js';

export function parseTlv(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 8) throw new Error('Incomplete RTC message');
  const length = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, false);
  if (length > bytes.length - 8) throw new Error('Invalid RTC message length');
  return { type: new TextDecoder().decode(bytes.slice(0,4)).replaceAll('\0',''), payload: JSON.parse(new TextDecoder().decode(bytes.slice(8,8+length))) };
}

function readableError(error) {
  const message = error?.message ?? String(error);
  if (/NotAllowed|permission|Permission/i.test(message) && !/NoPermissionForApp/.test(message)) return 'Microphone access was denied. Allow it in your browser, then try again.';
  if (/NotFound|device not found/i.test(message)) return 'No microphone found. Connect one and try again.';
  if (/NoPermissionForApp/.test(message)) return 'Voice service is not enabled for this application.';
  if (/AbortError|aborted|timeout/i.test(message)) return 'The voice connection timed out. Your transcript is still here. Try again.';
  if (/configuration.*missing/i.test(message)) return 'Voice service is not configured. Ask the administrator to complete setup.';
  return message;
}

// Let the browser resolve its default alias. Different devices can share groupId.
export function chooseMicrophone(devices, preferred = '') {
  return devices.find(d => d.deviceId === preferred) ?? devices.find(d => d.deviceId === 'default') ?? devices[0];
}

export function capturedMicrophone(devices, settings, track) {
  const actual = settings?.deviceId ?? track?.getSettings()?.deviceId;
  const physical = devices.filter(d => !['default','communications'].includes(d.deviceId));
  const byId = physical.find(d => d.deviceId === actual);
  if (byId) return byId;
  // Chromium may return the alias in getSettings; the captured track has its real label.
  const byLabel = physical.filter(d => track?.label && (d.label === track.label || track.label.endsWith(` - ${d.label}`)));
  if (byLabel.length === 1) return byLabel[0];
  throw new Error('The microphone could not be identified. Select a specific device and try again.');
}

/** The same state machine runs in the React app and the standalone client. */
export function createVoiceRuntime({ loadRtc, storage = globalThis.localStorage, fetchFn = globalThis.fetch, record = recordVoiceSample }) {
  let workspace, storageError = '';
  try { workspace = readWorkspace(storage); } catch (error) { workspace = newWorkspace(); storageError = readableError(error); }
  let state = { phase:'idle', muted:false, engagement:null, enrollmentId:null, recording:false, seconds:0, error:storageError, storageError, saved:!storageError, autoplayBlocked:false, voiceStatus:'', activeSpeaker:null, contextStatus:'', pendingOutline:null, microphones:[], microphoneId:workspace.microphoneId ?? '', captureDeviceId:'', inputLevel:0, hasInput:false, connectionStep:'' };
  let connection = null, startup = null, epoch = 0, replyEpoch = 0, queue = Promise.resolve(), recorder = null, responseTimer = null;
  let targetPersonId = null, draftTarget = null;
  const listeners = new Set();
  const current = () => workspace.conversations.find(c => c.id === workspace.currentId);
  const notify = kind => listeners.forEach(fn => fn(kind));
  const setState = changes => { state = {...state,...changes}; notify(Object.keys(changes).every(k => ['inputLevel','hasInput'].includes(k)) ? 'audio' : 'change'); };
  const persist = () => {
    if (storageError) return;
    try { storage.setItem(WORKSPACE_KEY, JSON.stringify(workspace)); state = {...state,saved:true}; }
    catch { state = {...state,saved:false,storageError:'Could not save on this device. Export your conversations before clearing browser storage.'}; }
  };
  // Drafts reference this ID even before the first message or voice call.
  persist();
  const change = transform => {
    workspace = {...workspace,conversations:workspace.conversations.map(c => c.id === workspace.currentId ? transform(c) : c)};
    persist(); notify();
  };
  const report = error => setState({error:readableError(error)});
  async function verifyCapture(ctx, requested, settings) {
    let track = ctx.engine.getLocalStreamTrack?.(0,'audio');
    const actual = capturedMicrophone(state.microphones,settings,track);
    if (!['default','communications'].includes(requested) && actual.deviceId !== requested) throw new Error('The active microphone does not match your selection. Choose the microphone again.');
    // Bind a physical ID after resolving the live alias, then verify the SDK honored it.
    if (['default','communications'].includes(requested)) {
      await ctx.engine.setAudioCaptureDevice(actual.deviceId);
      track = ctx.engine.getLocalStreamTrack?.(0,'audio');
      if (track?.getSettings()?.deviceId !== actual.deviceId) throw new Error('The microphone did not switch. Choose it again.');
    }
    ctx.mic = actual.deviceId;
    setState({captureDeviceId:ctx.mic});
    return track;
  }
  async function startCapture(ctx) {
    const requested = ctx.mic;
    const settings = await ctx.engine.startAudioCapture(requested);
    return verifyCapture(ctx,requested,settings);
  }
  async function post(path, body, timeout = 30000) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    try {
      const response = await fetchFn(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body ?? {}),signal:abort.signal});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      return data;
    } finally { clearTimeout(timer); }
  }
  function clearResponse() {
    replyEpoch++; clearTimeout(responseTimer); responseTimer = null;
    targetPersonId = null; draftTarget = null;
    if (connection) {
      connection.replyAfterRound = Infinity;
      connection.replyRound = null;
      connection.engine?.setPlaybackVolume(connection.session.botUserId,0,0);
    }
    state = {...state,pendingOutline:null};
  }
  async function release(ctx) {
    if (!ctx || ctx.released) return;
    ctx.released = true;
    clearTimeout(ctx.readyTimer); clearTimeout(ctx.expiryTimer);
    if (ctx.engine) {
      await ctx.engine.stopAudioCapture().catch(() => {});
      await ctx.engine.leaveRoom(false).catch(() => {});
      ctx.VERTC.destroyEngine(ctx.engine);
    }
    // Called after an uncertain Start too: leaving RTC alone does not stop billing immediately.
    if (ctx.startAttempted && ctx.session) {
      try { await post('/api/voicechat/stop',ctx.session,15000); }
      catch (error) { report(new Error(`Your microphone is off, but the server has not confirmed the call ended: ${readableError(error)}`)); }
    }
  }
  async function stop() {
    if (state.phase === 'idle' && !startup) return;
    ++epoch; clearResponse(); recorder?.abort(); recorder = null;
    const ctx = connection;
    setState({phase:'ending',recording:false,engagement:null});
    ctx?.cancelReady?.();
    ctx?.cancelStep?.();
    await ctx?.engine?.stopAudioCapture().catch(() => {});
    // Let a pending Start settle before Stop, so a late Start cannot create an orphan task.
    await startup?.catch(() => {});
    await queue.catch(() => {});
    await release(ctx);
    if (connection === ctx) connection = null;
    setState({phase:'idle',muted:false,enrollmentId:null,activeSpeaker:null,contextStatus:'',inputLevel:0,connectionStep:''});
  }
  function enqueue(action, buildBody, generation = replyEpoch) {
    const ctx = connection;
    const work = queue.catch(() => {}).then(async () => {
      if (!ctx || ctx !== connection || ctx.released || generation !== replyEpoch || state.phase === 'ending') return false;
      await post('/api/voicechat/update',{...ctx.session,action,...buildBody()});
      return generation === replyEpoch && ctx === connection;
    });
    queue = work;
    return work;
  }
  async function interrupt() {
    clearResponse();
    if (!connection?.ready) return;
    await enqueue('interrupt',()=>({}));
    setState({phase:state.enrollmentId ? 'enrolling' : 'listening'});
  }
  async function listenOnly() {
    setState({engagement:null});
    await interrupt();
  }
  async function respond(text, personId, outline = false) {
    if (!connection?.ready || state.enrollmentId || state.phase === 'ending') return;
    clearResponse();
    const generation = replyEpoch;
    targetPersonId = personId; draftTarget = outline ? personId : null;
    setState({phase:'thinking',pendingOutline:draftTarget,error:''});
    try {
      // Automatic ASR must finish independently. Cancel its automatic reply;
      // only the new round requested with the corrected app context may play.
      if (!await enqueue('interrupt',()=>({}),generation)) return;
      connection.replyAfterRound = connection.lastRound;
      const done = await enqueue('respond',()=>({context:conversationContext(current()),purpose:outline ? 'outline' : 'conversation',text:JSON.stringify({currentPersonId:personId,request:outline ? 'Organize this person’s outline.' : 'Reply to the current student.',studentText:text})}),generation);
      if (done && ['thinking','speaking'].includes(state.phase)) responseTimer = setTimeout(() => { clearResponse(); setState({phase:'listening',error:'No complete reply received. Try asking again. Your transcript is still here.'}); },45000);
    } catch (error) { if (generation === replyEpoch) { clearResponse(); setState({phase:'listening'}); report(error); } }
  }
  function subtitle(ctx, data) {
    if (ctx !== connection || ctx.released || state.phase === 'ending') return;
    if (data.userId !== ctx.session.botUserId && data.userId !== ctx.session.userId) return;
    if (ctx.enrollment) {
      if (!state.recording || data.userId === ctx.session.botUserId) return;
      ctx.intro = data.text || ctx.intro;
      const name = extractIntroducedName(ctx.intro);
      if (name && !current().people.find(p => p.memberId === state.enrollmentId)?.name) change(c => updatePerson(c,state.enrollmentId,{name}));
      setState({intro:ctx.intro}); return;
    }
    const round = Number.isInteger(data.roundId) ? data.roundId : null;
    if (data.userId !== ctx.session.botUserId && round !== null && ctx.studentRound !== null && round < ctx.studentRound) return;
    if (round !== null) ctx.lastRound = Math.max(ctx.lastRound,round);
    if (data.userId === ctx.session.botUserId) {
      if (round === null || round <= ctx.replyAfterRound || (ctx.replyRound !== null && ctx.replyRound !== round)) return;
      ctx.replyRound = round;
      ctx.engine.setPlaybackVolume(ctx.session.botUserId,0,100);
    } else if (round !== ctx.studentRound) {
      ctx.studentRound = round;
      clearResponse();
    }
    const before = current().lines;
    change(c => receiveSubtitle(c,data,ctx.session));
    let line = current().lines.find(l => l !== before.find(old => old.key === l.key));
    if (!line) return;
    if (line.role === 'hermes') {
      if (targetPersonId && !line.targetPersonId) change(c => ({...c,lines:c.lines.map(l => l.key === line.key ? {...l,targetPersonId} : l)}));
      if (line.paragraph) {
        clearTimeout(responseTimer);
        if (draftTarget) { const person = draftTarget; draftTarget = null; change(c => saveDraft(c,person,line.text)); }
        setState({pendingOutline:null});
      }
      return;
    }
    setState({activeSpeaker:line.speakerId});
    if (!line.paragraph || ctx.handled.has(line.key)) return;
    ctx.handled.add(line.key);
    const decision = responseDecision(current().mode,line.text,line.speakerId,state.engagement);
    setState({engagement:decision.engagement});
    if (decision.action === 'listen') void listenOnly().catch(report);
    if (decision.action === 'record') void interrupt().catch(report);
    if (decision.action === 'respond') void respond(decision.text,line.speakerId);
  }
  async function start() {
    if (state.phase !== 'idle' || startup) return;
    if (storageError) { report(storageError); return; }
    const ticket = ++epoch;
    const ctx = {session:null,engine:null,VERTC:null,released:false,startAttempted:false,ready:false,handled:new Set(),enrollment:false,mic:'',intro:'',lastRound:0,studentRound:null,replyAfterRound:Infinity,replyRound:null};
    connection = ctx;
    const check = () => { if (ticket !== epoch) throw new DOMException('Cancelled','AbortError'); };
    const step = async (promise, message) => {
      let timer;
      try {
        return await Promise.race([promise,new Promise((_,reject)=>{
          ctx.cancelStep=()=>reject(new DOMException('Cancelled','AbortError'));
          timer=setTimeout(()=>reject(new Error(message)),18000);
        })]);
      } finally { clearTimeout(timer); ctx.cancelStep=null; }
    };
    setState({phase:'permission',error:'',muted:false,autoplayBlocked:false,inputLevel:0,hasInput:false});
    startup = (async () => {
      const rtc = await step(loadRtc(),'The voice component timed out. Refresh and try again.'); check();
      ctx.VERTC = rtc.default;
      const permission = await step(ctx.VERTC.enableDevices({audio:true,video:false}),'Could not open the microphone. Check microphone permission in your browser.'); check();
      if (!permission.audio) throw permission.audioExceptionError ?? new Error('Microphone permission denied');
      const devices = (await ctx.VERTC.enumerateAudioCaptureDevices()).filter(d => d.kind === 'audioinput' && d.deviceId); check();
      const people = participants(current());
      const preferredMicrophone = devices.some(d=>d.deviceId===workspace.microphoneId) ? workspace.microphoneId : '';
      const microphone = chooseMicrophone(devices,preferredMicrophone);
      ctx.mic = microphone?.deviceId;
      if (!ctx.mic) throw new Error('Microphone device not found');
      setState({phase:'connecting',microphones:devices,microphoneId:microphone.deviceId,captureDeviceId:'',connectionStep:'Opening microphone',voiceStatus:''});
      ctx.session = await post('/api/session'); check();
      ctx.engine = ctx.VERTC.createEngine(ctx.session.appId);
      ctx.engine.setPlaybackVolume(ctx.session.botUserId,0,0);
      const events = ctx.VERTC.events;
      ctx.engine.on(events.onError,event => { if (ctx === connection && ticket === epoch) { report(new Error(`Voice disconnected (${event.errorCode}). End the call and reconnect.`)); void stop(); } });
      ctx.engine.on(events.onAutoplayFailed,()=>setState({autoplayBlocked:true}));
      ctx.engine.on(events.onLocalAudioPropertiesReport,items => {
        if (ctx !== connection || ctx.released || state.muted || state.phase === 'ending') return;
        const inputLevel = Math.max(0,...items.filter(item => item.streamIndex === 0).map(item => item.audioPropertiesInfo?.linearVolume ?? 0));
        setState({inputLevel:Math.min(255,inputLevel),hasInput:state.hasInput || inputLevel > 25});
      });
      ctx.engine.enableAudioPropertiesReport?.({interval:200});
      ctx.engine.on(events.onTrackEnded,event => {
        if (event.kind === 'audio' && !event.isScreen && ctx === connection && ctx.ready && !ctx.released && !state.muted && !ctx.enrollment && state.phase !== 'ending') {
          report(new Error('Microphone disconnected. Select a microphone to continue.')); void stop();
        }
      });
      let readyResolve, readyReject;
      const readyPromise = new Promise((resolve,reject) => { readyResolve=resolve; readyReject=reject; });
      // Attach immediately: a user cancellation may reject while Start is pending.
      readyPromise.catch(()=>{});
      ctx.cancelReady = ()=>readyReject(new DOMException('Cancelled','AbortError'));
      const ready = () => {
        if (ctx !== connection || ticket !== epoch || !ctx.started || !ctx.joined) return;
        ctx.ready = true; clearTimeout(ctx.readyTimer);
        const next = participants(current()).find(p => !p.voiceprintId || p.deviceId !== ctx.mic);
        setState({phase:ctx.enrollment ? 'enrolling' : 'listening',enrollmentId:ctx.enrollment ? next?.memberId : null,engagement:current().mode === 'solo' ? 'next' : null});
        readyResolve();
      };
      ctx.engine.on(events.onUserJoined,event => { if (event.userInfo.userId === ctx.session.botUserId) {ctx.joined = true; ready();} });
      ctx.engine.on(events.onUserLeave,event => { if (event.userInfo.userId === ctx.session.botUserId && ticket === epoch && !ctx.released) { report(new Error('Voice service disconnected. Reconnect to continue.')); void stop(); } });
      ctx.engine.on(events.onRoomBinaryMessageReceived,event => {
        if (ctx !== connection || ticket !== epoch || event.userId !== ctx.session.botUserId) return;
        try {
          const {type,payload} = parseTlv(event.message);
          if (type === 'subv') for (const item of payload.data ?? []) subtitle(ctx,item);
          if (type === 'conv' && ctx.ready && !ctx.enrollment) {
            const code = payload.Stage?.Code;
            const round = payload.RoundID;
            if (Number.isInteger(round)) ctx.lastRound = Math.max(ctx.lastRound,round);
            if (code === 1 && Number.isInteger(round) && (ctx.studentRound === null || round > ctx.studentRound)) {
              ctx.studentRound = round; clearResponse(); setState({phase:'listening'});
            }
            if (code === 3 && Number.isInteger(round) && round > ctx.replyAfterRound && (ctx.replyRound === null || ctx.replyRound === round)) {
              ctx.replyRound = round; ctx.engine.setPlaybackVolume(ctx.session.botUserId,0,100); setState({phase:'speaking'});
            }
            if ([4,5].includes(code) && round === ctx.replyRound) setState({phase:'listening'});
          }
          if (type === 'stat' && payload.event === 'VoicePrintStatus') setState({voiceStatus:payload.status === 'Active' ? 'Speaker recognition is on' : 'Speaker recognition is not ready. Contributions will be marked Unassigned.'});
        } catch { report(new Error('A voice message could not be read. Check the transcript.')); }
      });
      // Show real input levels while connecting, including when the room fails.
      await step(startCapture(ctx),'Could not capture audio. Check the microphone.'); check();
      ctx.enrollment = current().mode === 'group' && people.some(p => !p.voiceprintId || p.deviceId !== ctx.mic);
      setState({captureDeviceId:ctx.mic,connectionStep:'Connecting voice',voiceStatus:!ctx.enrollment && current().mode === 'group' ? 'Loading speaker recognition' : ''});
      await step(ctx.engine.joinRoom(ctx.session.rtcToken,ctx.session.roomId,{userId:ctx.session.userId,extraInfo:JSON.stringify({call_scene:'RTC-AIGC'})},{isAutoPublish:false,isAutoSubscribeAudio:true,roomProfileType:rtc.RoomProfileType.chat}),'This browser could not connect voice. Open this page in Edge or Chrome and try again.'); check();
      await step(ctx.engine.publishStream(rtc.MediaType.AUDIO),'Audio could not connect. Try again.'); check();
      if (ctx.enrollment) await ctx.engine.stopAudioCapture();
      setState({connectionStep:'Connecting to Mimi'});
      ctx.startAttempted = true;
      const configuration = await post('/api/voicechat/start',{...ctx.session,mode:ctx.enrollment ? 'enrollment' : current().mode,members:people,context:conversationContext(current())}); check();
      Object.assign(ctx.session,{configTicket:configuration.configTicket,configRevision:configuration.configRevision,voiceprintScore:configuration.voiceprintScore});
      ctx.started = true; ready();
      if (!ctx.ready) ctx.readyTimer = setTimeout(()=>readyReject(new Error('Mimi could not join the call. Try again.')),20000);
      await readyPromise; check();
      ctx.expiryTimer = setTimeout(()=>{ if (ctx === connection && ticket === epoch) {report(new Error('This call has expired. Select Continue talking to reconnect.')); void stop();} },Math.max(1000,ctx.session.expiresAt*1000-Date.now()-5000));
    })();
    try { await startup; }
    catch (error) { await release(ctx); if (ticket === epoch) {connection = null; setState({phase:'idle',inputLevel:0,connectionStep:''}); report(error);} }
    finally { startup = null; }
  }
  async function enroll() {
    const ctx = connection, personId = state.enrollmentId;
    if (!ctx?.ready || !personId || recorder || state.recording) return;
    recorder = new AbortController(); const control = recorder; const ticket = epoch;
    setState({recording:true,seconds:0,intro:'',error:''});
    try {
      await startCapture(ctx);
      const sample = await record({deviceId:ctx.mic,signal:control.signal,onProgress:seconds=>setState({seconds})});
      await ctx.engine.stopAudioCapture();
      if (control.signal.aborted || ticket !== epoch) return;
      setState({phase:'registering'});
      const result = await post('/api/voiceprint/register',{name:personId.slice(-32),audio:sample.audio});
      if (control.signal.aborted || ticket !== epoch) return;
      if (!result.voiceprintId) throw new Error('Voice registration returned no result. Try again.');
      change(c => updatePerson(c,personId,{voiceprintId:result.voiceprintId,deviceId:sample.deviceId}));
      const next = participants(current()).find(p => !p.voiceprintId || p.deviceId !== ctx.mic);
      setState({enrollmentId:next?.memberId ?? null,phase:'enrolling',recording:false,intro:'',seconds:0});
      if (!next) { recorder = null; await stop(); await start(); }
    } catch (error) { if (ticket === epoch && !control.signal.aborted) { setState({phase:'enrolling'}); report(error); } }
    finally { if (ticket === epoch) { await ctx.engine?.stopAudioCapture().catch(()=>{}); setState({recording:false}); } if (recorder === control) recorder = null; }
  }
  async function cancelEnrollment() { recorder?.abort(); await connection?.engine?.stopAudioCapture(); setState({recording:false,phase:'enrolling',seconds:0}); }
  async function syncCorrection() {
    if (!connection?.ready || connection.enrollment) return;
    await interrupt();
    setState({contextStatus:'Syncing corrections'});
    try { const done = await enqueue('context',()=>({context:conversationContext(current())})); if (done) setState({contextStatus:'Corrections will be used in future replies'}); }
    catch (error) { setState({contextStatus:'Corrections are saved on this device and will sync before the next reply'}); report(error); }
  }
  return {
    getSnapshot:()=>({workspace,conversation:current(),state}), subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
    start, stop, enroll, cancelEnrollment, listenOnly, interrupt, report,
    async ask() { if (state.muted) await this.toggleMute(); setState({engagement:'next'}); },
    async toggleMute() { if (!connection?.ready || connection.enrollment) return; if (state.muted) await startCapture(connection); else await connection.engine.stopAudioCapture(); setState({muted:!state.muted,inputLevel:0}); },
    async selectMicrophone(id) {
      const selected = chooseMicrophone(state.microphones,id);
      if (!state.microphones.some(d=>d.deviceId===id) || !selected) return;
      const ctx = connection;
      if (ctx?.ready && current().mode === 'solo') {
        await ctx.engine.setAudioCaptureDevice(selected.deviceId);
        if (state.muted) { ctx.mic = selected.deviceId; }
        else { const track = ctx.engine.getLocalStreamTrack(0,'audio'); await verifyCapture(ctx,selected.deviceId,track?.getSettings()); }
      }
      else if (ctx) await stop();
      workspace = {...workspace,microphoneId:id}; persist();
      setState({microphoneId:id,captureDeviceId:ctx?.mic ?? '',inputLevel:0,hasInput:false});
    },
    async newConversation(mode, {keepEmpty = false} = {}) { await stop(); const c = newConversation(mode); const old = current(); const empty = !keepEmpty && !old.lines.length && !old.people.some(p => p.name || p.voiceprintId); workspace = {...workspace,currentId:c.id,conversations:[...(empty ? workspace.conversations.filter(x=>x.id!==old.id) : workspace.conversations),c]}; persist(); notify(); },
    async selectConversation(id) { if (!workspace.conversations.some(c=>c.id===id)) return; await stop(); workspace = {...workspace,currentId:id}; persist(); notify(); },
    async rename(id,name) { if ([...name.trim()].length > 32) throw new Error('Use a name of up to 32 characters.'); change(c=>updatePerson(c,id,{name:name.trim()})); await syncCorrection(); },
    async replace(id) { await stop(); change(c=>replacePerson(c,id)); },
    async reregister(id) { await stop(); change(c=>updatePerson(c,id,{voiceprintId:'',deviceId:''})); await start(); },
    async correct(key,personId,text) { change(c=>correctText(correctAttribution(c,key,personId),key,text)); await syncCorrection(); },
    async sendText(text,personId) { if (!text.trim()) return; if (current().mode === 'group') setState({engagement:null}); change(c=>addText(c,text,personId)); if (!connection?.ready) await start(); await respond(text,personId); },
    async outline(personId) { if (!current().lines.some(l=>l.role==='student' && l.speakerId===personId && l.paragraph)) throw new Error('No contributions from this person yet.'); if (!connection?.ready) await start(); await respond('',personId,true); },
    saveOutline(personId,text,status) { if (!text.trim()) throw new Error('The outline cannot be empty.'); change(c=>saveDraft(c,personId,text.trim(),status)); },
    async enableSound() { if (!connection?.ready) return; try { await connection.engine.play(connection.session.botUserId); setState({autoplayBlocked:false}); } catch (error) { setState({autoplayBlocked:true}); report(error); } },
    pagehide() { recorder?.abort(); if (connection?.session) navigator.sendBeacon('/api/voicechat/stop',new Blob([JSON.stringify(connection.session)],{type:'application/json'})); void stop(); },
    exportRaw() { return storageError ? storage.getItem(WORKSPACE_KEY) ?? storage.getItem('hermes.group.v1') ?? '' : JSON.stringify(workspace,null,2); },
    destroy() { listeners.clear(); void stop(); },
  };
}
