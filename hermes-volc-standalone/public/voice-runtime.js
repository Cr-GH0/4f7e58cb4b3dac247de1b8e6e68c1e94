import { WORKSPACE_KEY, newWorkspace, newConversation, readWorkspace, updatePerson, attachAccount, receiveSubtitle, conversationContext, correctAttribution, correctText, addText, addTalkExchange, saveDraft } from './conversation.js';

export function parseTlv(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 8) throw new Error('Incomplete RTC message');
  const length = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, false);
  if (length > bytes.length - 8) throw new Error('Invalid RTC message length');
  return { type: new TextDecoder().decode(bytes.slice(0,4)).replace(/\0/g,''), payload: JSON.parse(new TextDecoder().decode(bytes.slice(8,8+length))) };
}

export function readableError(error) {
  const message = error?.message ?? String(error);
  if (/NoPermissionForApp/.test(message)) return 'Voice service is not enabled for this application.';
  if (/AbortError|aborted|timeout/i.test(message)) return 'The voice connection timed out. Your transcript is still here. Try again.';
  if (/configuration.*missing/i.test(message)) return 'Voice service is not configured. Ask the administrator to complete setup.';
  return message;
}

/** The same state machine runs in the React app and the standalone client. */
export function createVoiceRuntime({ loadRtc, storage = globalThis.localStorage, fetchFn = globalThis.fetch, account = null, onRename, talk = null }) {
  let workspace, storageError = '';
  try { workspace = readWorkspace(storage); } catch (error) { workspace = newWorkspace(); storageError = readableError(error); }
  if (account) workspace = { ...workspace, conversations: workspace.conversations.map(c => attachAccount(c, account)) };
  let state = { phase:'idle', error:storageError, autoplayBlocked:false, connectionStep:'', contextStatus:'', pendingOutline:null, saved:!storageError, storageError, talkMode:false, talkAudio:null };
  let connection = null, startup = null, epoch = 0, replyEpoch = 0, queue = Promise.resolve(), responseTimer = null;
  let draftTarget = null, talkActive = false;
  const listeners = new Set();
  const current = () => workspace.conversations.find(c => c.id === workspace.currentId);
  const notify = () => listeners.forEach(fn => fn('change'));
  const setState = changes => { state = {...state,...changes}; notify(); };
  const persist = () => {
    if (storageError) return;
    try { storage.setItem(WORKSPACE_KEY, JSON.stringify(workspace)); state = {...state,saved:true}; }
    catch { state = {...state,saved:false,storageError:'Could not save on this device. Export your conversations before clearing browser storage.'}; }
  };
  // Drafts reference this ID even before the first message.
  persist();
  const change = transform => {
    workspace = {...workspace,conversations:workspace.conversations.map(c => c.id === workspace.currentId ? transform(c) : c)};
    persist(); notify();
  };
  const report = error => setState({error:readableError(error)});
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
    draftTarget = null;
    if (connection) {
      // The bot stays muted until the application explicitly requests a reply.
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
      await ctx.engine.leaveRoom(false).catch(() => {});
      ctx.VERTC.destroyEngine(ctx.engine);
    }
    // Called after an uncertain Start too: leaving RTC alone does not stop billing immediately.
    if (ctx.startAttempted && ctx.session) {
      try { await post('/api/voicechat/stop',ctx.session,15000); }
      catch (error) { report(new Error(`The call has ended on your side, but the server has not confirmed it: ${readableError(error)}`)); }
    }
  }
  async function stop() {
    if (state.phase === 'idle' && !startup) return;
    ++epoch; clearResponse();
    const ctx = connection;
    setState({phase:'ending'});
    ctx?.cancelReady?.();
    ctx?.cancelStep?.();
    // Let a pending Start settle before Stop, so a late Start cannot create an orphan task.
    await startup?.catch(() => {});
    await queue.catch(() => {});
    await release(ctx);
    if (connection === ctx) connection = null;
    setState({phase:'idle',connectionStep:'',talkAudio:null,autoplayBlocked:false});
  }
  /** Text fallback: send the typed message and play the synthesized reply. */
  async function speakTalkReply(reply) {
    try {
      if (reply.audio) {
        await talk.play(reply.audio, reply.mime);
        if (reply.audio2) await talk.play(reply.audio2, reply.mime);
      } else await talk.speak?.(reply.replyText);
      setState({autoplayBlocked:false});
    } catch { setState({autoplayBlocked:true}); }
  }
  async function sendTalkText(text, personId) {
    const ticket = epoch;
    setState({phase:'thinking',error:''});
    try {
      const reply = await post('/api/talk',{text,context:conversationContext(current())},30000);
      if (ticket !== epoch) return;
      change(c => addTalkExchange(c,personId,'',reply.replyText));
      setState({phase:'speaking',talkAudio:reply.audio ? {audio:reply.audio,mime:reply.mime,audio2:reply.audio2} : null});
      await speakTalkReply(reply);
      if (ticket === epoch && state.phase === 'speaking') setState({phase:'idle',talkAudio:null});
    } catch (error) { if (ticket === epoch) { setState({phase:'idle',talkAudio:null}); report(error); } }
  }
  async function talkOutline(personId) {
    const ticket = epoch;
    setState({phase:'thinking',pendingOutline:personId,error:''});
    try {
      const reply = await post('/api/talk',{purpose:'outline',context:conversationContext(current())},30000);
      if (ticket !== epoch) return;
      change(c => saveDraft(c,personId,reply.replyText));
      setState({phase:'idle',pendingOutline:null});
    } catch (error) { if (ticket === epoch) { setState({phase:'idle',pendingOutline:null}); report(error); } }
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
    setState({phase:'listening'});
  }
  async function respond(text, personId, outline = false) {
    if (!connection?.ready || state.phase === 'ending') return;
    clearResponse();
    const generation = replyEpoch;
    draftTarget = outline ? personId : null;
    setState({phase:'thinking',pendingOutline:draftTarget,error:''});
    try {
      // The server performs interrupt → context update → reply trigger in one
      // round trip; the corrected context is refreshed before the reply starts.
      connection.replyAfterRound = connection.lastRound;
      const done = await enqueue('respond',()=>({context:conversationContext(current()),purpose:outline ? 'outline' : 'conversation',text:JSON.stringify({currentPersonId:personId,request:outline ? 'Organize this person’s outline.' : 'Reply to the current student.',studentText:text})}),generation);
      if (done && ['thinking','speaking'].includes(state.phase)) responseTimer = setTimeout(() => { clearResponse(); setState({phase:'listening',error:'No complete reply received. Try asking again. Your transcript is still here.'}); },45000);
    } catch (error) { if (generation === replyEpoch) { clearResponse(); setState({phase:'listening'}); report(error); } }
  }
  function subtitle(ctx, data) {
    if (ctx !== connection || ctx.released || state.phase === 'ending') return;
    if (data.userId !== ctx.session.botUserId) return;
    const round = Number.isInteger(data.roundId) ? data.roundId : null;
    if (round !== null) ctx.lastRound = Math.max(ctx.lastRound,round);
    // Accept rounds newer than the suppression point and never older than one
    // already accepted: a late fragment of an older round is dropped, while a
    // newer round stays eligible even while an older reply is still open.
    if (round === null || round <= ctx.replyAfterRound) return;
    if (ctx.replyRound !== null && round < ctx.replyRound) return;
    const first = ctx.replyRound === null;
    ctx.replyRound = Math.max(ctx.replyRound ?? 0, round);
    ctx.engine.setPlaybackVolume(ctx.session.botUserId,0,100);
    if (first) setState({phase:'speaking'});
    const before = current().lines;
    change(c => receiveSubtitle(c,data,ctx.session));
    const line = current().lines.find(l => l !== before.find(old => old.key === l.key));
    if (!line) return;
    // Every reply belongs to the single student in the conversation.
    if (!line.targetPersonId) { const owner = current().participantIds[0]; change(c => ({...c,lines:c.lines.map(l => l.key === line.key ? {...l,targetPersonId:owner} : l)})); }
    if (line.paragraph) {
      clearTimeout(responseTimer);
      if (draftTarget) { const person = draftTarget; draftTarget = null; change(c => saveDraft(c,person,line.text)); }
      setState({pendingOutline:null});
    }
  }
  async function start() {
    if (state.phase !== 'idle' || startup) return;
    if (storageError) { report(storageError); return; }
    const ticket = ++epoch;
    const ctx = {session:null,engine:null,VERTC:null,released:false,startAttempted:false,ready:false,started:false,joined:false,lastRound:0,replyAfterRound:Infinity,replyRound:null};
    connection = ctx;
    const check = () => { if (ticket !== epoch) throw new DOMException('Cancelled','AbortError'); };
    const step = async (promise, message, timeout = 18000) => {
      let timer;
      try {
        return await Promise.race([promise,new Promise((_,reject)=>{
          ctx.cancelStep=()=>reject(new DOMException('Cancelled','AbortError'));
          timer=setTimeout(()=>reject(new Error(message)),timeout);
        })]);
      } finally { clearTimeout(timer); ctx.cancelStep=null; }
    };
    setState({phase:'connecting',error:'',autoplayBlocked:false,connectionStep:'Loading the voice engine'});
    startup = (async () => {
      const rtc = await step(loadRtc(),'The voice component timed out. Refresh and try again.'); check();
      ctx.VERTC = rtc.default;
      setState({connectionStep:'Opening the room'});
      ctx.session = await post('/api/session'); check();
      ctx.engine = ctx.VERTC.createEngine(ctx.session.appId);
      // The bot stays muted until a requested reply round is accepted.
      ctx.engine.setPlaybackVolume(ctx.session.botUserId,0,0);
      const events = ctx.VERTC.events;
      ctx.engine.on(events.onError,event => { if (ctx === connection && ticket === epoch) { report(new Error(`Voice disconnected (${event.errorCode}). End the call and reconnect.`)); void stop(); } });
      ctx.engine.on(events.onAutoplayFailed,() => setState({autoplayBlocked:true}));
      let readyResolve, readyReject;
      const readyPromise = new Promise((resolve,reject) => { readyResolve=resolve; readyReject=reject; });
      // Attach immediately: a user cancellation may reject while Start is pending.
      readyPromise.catch(()=>{});
      ctx.cancelReady = ()=>readyReject(new DOMException('Cancelled','AbortError'));
      const ready = () => {
        if (ctx !== connection || ticket !== epoch || !ctx.started || !ctx.joined || ctx.ready) return;
        ctx.ready = true; clearTimeout(ctx.readyTimer);
        setState({phase:'listening'});
        readyResolve();
      };
      ctx.engine.on(events.onUserJoined,event => { if (event.userInfo.userId === ctx.session.botUserId) {ctx.joined = true; ready();} });
      ctx.engine.on(events.onUserLeave,event => { if (event.userInfo.userId === ctx.session.botUserId && ticket === epoch && !ctx.released) { report(new Error('Voice service disconnected. Reconnect to continue.')); void stop(); } });
      ctx.engine.on(events.onRoomBinaryMessageReceived,event => {
        if (ctx !== connection || ticket !== epoch || event.userId !== ctx.session.botUserId) return;
        try {
          const {type,payload} = parseTlv(event.message);
          if (type === 'subv') for (const item of payload.data ?? []) subtitle(ctx,item);
          if (type === 'conv' && ctx.ready) {
            const code = payload.Stage?.Code;
            const round = payload.RoundID;
            if (Number.isInteger(round)) ctx.lastRound = Math.max(ctx.lastRound,round);
            if (code === 3 && Number.isInteger(round) && round > ctx.replyAfterRound && (ctx.replyRound === null || round >= ctx.replyRound)) {
              ctx.replyRound = Math.max(ctx.replyRound ?? 0, round); ctx.engine.setPlaybackVolume(ctx.session.botUserId,0,100); setState({phase:'speaking'});
            }
            if ([4,5].includes(code) && Number.isInteger(round) && round <= (ctx.replyRound ?? -1)) setState({phase:'listening'});
          }
        } catch { report(new Error('A voice message could not be read. Check the transcript.')); }
      });
      await step(ctx.engine.joinRoom(ctx.session.rtcToken,ctx.session.roomId,{userId:ctx.session.userId,extraInfo:JSON.stringify({call_scene:'RTC-AIGC'})},{isAutoPublish:false,isAutoSubscribeAudio:true,roomProfileType:rtc.RoomProfileType.chat}),'The voice network did not connect. Try Wi-Fi or mobile data, then reconnect.',10000); check();
      setState({connectionStep:'Connecting to Mimi'});
      ctx.startAttempted = true;
      const configuration = await post('/api/voicechat/start',{roomId:ctx.session.roomId,userId:ctx.session.userId,botUserId:ctx.session.botUserId,taskId:ctx.session.taskId,context:conversationContext(current())}); check();
      Object.assign(ctx.session,{configTicket:configuration.configTicket,configRevision:configuration.configRevision});
      ctx.started = true; ready();
      if (!ctx.ready) ctx.readyTimer = setTimeout(()=>readyReject(new Error('Mimi could not join the call. Try again.')),20000);
      await readyPromise; check();
      ctx.expiryTimer = setTimeout(()=>{ if (ctx === connection && ticket === epoch) {report(new Error('This call has expired. Select Continue talking to reconnect.')); void stop();} },Math.max(1000,ctx.session.expiresAt*1000-Date.now()-5000));
    })();
    try { await startup; }
    catch (error) {
      await release(ctx);
      if (ticket === epoch) {
        connection = null; setState({phase:'idle',connectionStep:''});
        // A browser that cannot run the live link falls back to plain text
        // turns instead of leaving the student stuck.
        const message = error instanceof Error ? error.message : String(error ?? '');
        if (talk && !/denied|permission|NotAllowed|secure https/i.test(message)) {
          talkActive = true;
          setState({talkMode:true});
          report(new Error('This browser cannot run the live voice link, so Mimi switched to text mode.'));
        } else report(error);
      }
    }
    finally { startup = null; }
  }
  /** Runs inside the sending tap so talk playback is unlocked by the gesture. */
  async function ensureReady() {
    talk.unlock?.();
    if (!connection?.ready && state.phase === 'idle' && !startup) await start();
    if (startup) await startup.catch(() => {});
    return Boolean(connection?.ready) && !talkActive;
  }
  async function syncCorrection() {
    if (!connection?.ready) return;
    await interrupt();
    setState({contextStatus:'Syncing corrections'});
    try { const done = await enqueue('context',()=>({context:conversationContext(current())})); if (done) setState({contextStatus:'Corrections will be used in future replies'}); }
    catch (error) { setState({contextStatus:'Corrections are saved on this device and will sync before the next reply'}); report(error); }
  }
  return {
    getSnapshot:()=>({workspace,conversation:current(),state}), subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
    start, stop, report,
    // Conversations are always single-student; the mode argument is accepted
    // for view compatibility and ignored.
    async newConversation(_mode, {keepEmpty = false} = {}) { await stop(); const c = attachAccount(newConversation(), account); const old = current(); const empty = !keepEmpty && !old.lines.length && !old.people.some(p => p.name); workspace = {...workspace,currentId:c.id,conversations:[...(empty ? workspace.conversations.filter(x=>x.id!==old.id) : workspace.conversations),c]}; persist(); notify(); },
    async selectConversation(id) { if (!workspace.conversations.some(c=>c.id===id)) return; await stop(); workspace = {...workspace,currentId:id}; persist(); notify(); },
    async rename(id,name) { if ([...name.trim()].length > 32) throw new Error('Use a name of up to 32 characters.'); if (account && onRename) { account = await onRename(name.trim()); workspace = {...workspace, conversations:workspace.conversations.map(c=>attachAccount(c,account))}; persist(); notify(); } else change(c=>updatePerson(c,id,{name:name.trim()})); await syncCorrection(); },
    async correct(key,personId,text) { change(c=>correctText(correctAttribution(c,key,personId),key,text)); await syncCorrection(); },
    async sendText(text,personId) {
      if (!text.trim()) return;
      change(c => addText(c,text,personId));
      if (talkActive) return sendTalkText(text,personId);
      if (await ensureReady()) await respond(text,personId);
      else if (talkActive) return sendTalkText(text,personId);
    },
    async outline(personId) {
      if (!current().lines.some(l=>l.role==='student' && l.speakerId===personId && l.paragraph)) throw new Error('No contributions from this person yet.');
      if (talkActive) return talkOutline(personId);
      if (await ensureReady()) await respond('',personId,true);
      else if (talkActive) return talkOutline(personId);
    },
    saveOutline(personId,text,status) { if (!text.trim()) throw new Error('The outline cannot be empty.'); change(c=>saveDraft(c,personId,text.trim(),status)); },
    async enableSound() {
      if (state.talkAudio) {
        const audio = state.talkAudio;
        try {
          await talk.play(audio.audio, audio.mime);
          if (audio.audio2) await talk.play(audio.audio2, audio.mime);
          setState({autoplayBlocked:false});
          if (state.phase === 'speaking' && state.talkAudio === audio) setState({phase:'idle',talkAudio:null});
        }
        catch (error) { report(error); }
        return;
      }
      if (!connection?.engine) return;
      try { await connection.engine.play(connection.session.botUserId); setState({autoplayBlocked:false}); } catch (error) { setState({autoplayBlocked:true}); report(error); }
    },
    pagehide() { if (connection?.session) navigator.sendBeacon('/api/voicechat/stop',new Blob([JSON.stringify(connection.session)],{type:'application/json'})); void stop(); },
    exportRaw() { return storageError ? storage.getItem(WORKSPACE_KEY) ?? storage.getItem('hermes.group.v1') ?? '' : JSON.stringify(workspace,null,2); },
    destroy() { listeners.clear(); void stop(); },
  };
}
