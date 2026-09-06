import { createVoiceRuntime } from './voice-runtime.js';
import { participants, personName, exportConversation } from './conversation.js';
import { createInputDrafts } from './input-drafts.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  muted: '<path d="m3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 1v4M5 10v2a7 7 0 0 0 12 5m2-5v-2M12 19v3m-4 0h8"/>',
  history: '<path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2"/>',
  settings: '<path d="m9 3-.7 2.4-2.3 1L3.8 6 2 9.2l1.7 1.7v2.2L2 14.8 3.8 18l2.2-.4 2.3 1L9 21h6l.7-2.4 2.3-1 2.2.4 1.8-3.2-1.7-1.7v-2.2L22 9.2 20.2 6l-2.2.4-2.3-1L15 3Z"/><circle cx="12" cy="12" r="3"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  wave: '<path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4"/>',
  end: '<path d="M4 15v-3c4-4 12-4 16 0v3l-4 1-1-3a9 9 0 0 0-6 0l-1 3Z"/>',
  text: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h.01M11 9h.01M15 9h.01M7 12h.01M11 12h.01M15 12h.01M8 15h8"/>',
  send: '<path d="M12 20V4m-7 7 7-7 7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-4-4L5 15l-1 5Z"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
};
const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
const portrait = (compact = false, phase = '') => `<div class="mimi-portrait${compact ? ' compact' : ''}" data-phase="${phase}"><img src="/mimi.png" width="288" height="288" alt="Mimi, your English teaching assistant" fetchpriority="high" draggable="false"><span class="mimi-signal" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span></div>`;
const header = (active = false, loading = false) => `<header class="app-header"><button data-action="history" class="header-button" ${active || loading ? 'disabled' : ''}>${svg('history')}<span>History</span></button><span class="wordmark">Mimi</span><button data-action="settings" class="header-button" ${loading ? 'disabled' : ''}>${svg('settings')}<span>Settings</span></button></header>`;
export const peopleForReview = (c, drafts) => c.people.filter(p => c.participantIds.includes(p.memberId) || c.drafts[p.memberId] || c.lines.some(l => l.speakerId === p.memberId) || drafts.get(c.id,'outline',p.memberId));
const reviewName = (c, personId) => personName(c,personId) + (c.participantIds.includes(personId) ? '' : ' (left group)');
const modeTabs = (mode, disabled = false) => `<div class="mode-switch" role="group" aria-label="Conversation mode">${[['solo','Solo'],['group','Group of 3']].map(([value,label]) => `<button type="button" data-action="mode" data-value="${value}" aria-pressed="${mode === value}" ${disabled ? 'disabled' : ''}>${label}</button>`).join('')}</div>`;

export const INITIAL_MARKUP = `<main class="mimi-app welcome-view"><div class="main-surface">${header(false,true)}${modeTabs('solo',true)}<section class="conversation-space" aria-label="Voice conversation"><div class="conversation-scroll"><div class="empty-conversation">${portrait()}<h1>Practice English with Mimi</h1></div></div><div class="conversation-bottom"><div class="call-controls"><button class="primary start-button" disabled>${svg('wave')}Start talking</button><button class="keyboard-button" disabled>${svg('text')}<span>Type a message</span></button></div></div></section></div><noscript>Enable JavaScript to use voice conversations.</noscript></main>`;

export function renderSoloEnrollment(state) {
  if (state.phase === 'review-voice') return `<section class="enrollment-stage solo-enrollment" aria-labelledby="voice-confirm-title"><h1 id="voice-confirm-title">Is this what you just said?</h1><blockquote class="voice-confirm-text">${esc(state.intro)}</blockquote><audio controls preload="none" src="${esc(state.sampleUrl)}" aria-label="Listen to your recording"></audio><p>Confirm if these are your words and this recording contains only your voice.</p><div class="voice-confirm-actions"><button class="primary" data-action="confirm-voice">Yes, that was me</button><button data-action="reject-voice">No, try again</button></div></section>`;
  if (['registering','transcribing-voice'].includes(state.phase)) return `<section class="enrollment-stage solo-enrollment" aria-live="polite"><h1>${state.phase === 'registering' ? 'Connecting your voice' : 'Checking what I heard'}</h1><p>${state.phase === 'registering' ? 'Your microphone is paused while Mimi connects your confirmed voice.' : 'Your microphone is paused. Your words will appear here for you to confirm.'}</p></section>`;
  return `<section class="enrollment-stage solo-enrollment" aria-labelledby="voice-intro-title"><h1 id="voice-intro-title">Let me learn your voice</h1><p>Say a few sentences in English for about 15 seconds, then pause. You can introduce yourself or tell me what you would like to discuss.</p><p>Stay close to your microphone. I’ll show you what I heard for you to confirm.</p>${state.recording ? `<progress max="20" value="${state.seconds}" aria-label="Voice recording progress"></progress><p class="progress-label">${state.seconds} / 20 seconds</p><p class="intro-subtitle" aria-live="polite">${esc(state.intro || '')}</p><button data-action="cancel-enroll">Cancel recording</button>` : '<button class="primary start-button" data-action="enroll">Try recording again</button>'}</section>`;
}

/** React owns the host; the same conversation UI also mounts in the standalone app. */
export function mountCoach(host, options) {
  const runtime = createVoiceRuntime(options);
  const drafts = createInputDrafts(options.storage ?? globalThis.localStorage);
  let panel = null, panelValue = null, filter = 'all', textOpen = false;
  let focusReturn = null, panelScroll = 0, conversationId = null;
  let voiceStarted = 0, inputTimer = null, submitting = false;
  const draft = (c, field, owner = '', fallback = '') => esc(drafts.get(c.id,field,owner,fallback));
  const download = (text, filename, type = 'text/plain;charset=utf-8') => {
    const url = URL.createObjectURL(new Blob([text],{type}));
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  };
  function openPanel(name, value = null) {
    focusReturn = {action:document.activeElement?.dataset?.action,value:document.activeElement?.dataset?.value};
    panel = name; panelValue = value; panelScroll = 0; render();
    host.querySelector('.side-panel input,.side-panel textarea,.side-panel select,.side-panel button')?.focus();
  }
  function closePanel() {
    panel = null; panelValue = null; render();
    [...host.querySelectorAll('[data-action]')].find(el => el.dataset.action === focusReturn?.action && el.dataset.value === focusReturn?.value)?.focus();
  }
  function selectPeople(c, selected, presentOnly = false) {
    return `<option value="unknown" ${!selected || selected === 'unknown' ? 'selected' : ''}>Unassigned</option>` + (presentOnly ? participants(c) : c.people).map(p => `<option value="${esc(p.memberId)}" ${p.memberId === selected ? 'selected' : ''}>${esc(personName(c,p.memberId))}${c.participantIds.includes(p.memberId) ? '' : ' (left group)'}</option>`).join('');
  }
  function renderPanel(c, state, workspace) {
    if (!panel) return '';
    const active = state.phase !== 'idle';
    let title = '', body = '';
    if (panel === 'history') {
      title = 'History';
      body = `<button class="new-conversation" data-action="new" ${active ? 'disabled' : ''}>${svg('plus')}New conversation</button><div class="history-list">${[...workspace.conversations].reverse().map(x => `<button data-action="select" data-value="${esc(x.id)}" aria-current="${x.id === c.id}" ${active ? 'disabled' : ''}><strong>${x.mode === 'solo' ? 'Solo practice' : participants(x).map(p => esc(personName(x,p.memberId))).join(', ')}</strong><span>${esc(new Date(x.updatedAt).toLocaleString('en-US',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}))}</span></button>`).join('')}</div><p class="panel-note">Conversations are saved in this browser on this device.</p>${c.lines.length ? '<button data-action="export">Export conversation</button>' : ''}<button data-action="export-all">Export all conversations</button>`;
    }
    if (panel === 'settings') {
      title = 'Settings';
      body = `${!active ? `<div class="settings-actions">${c.mode === 'solo' ? `<button data-action="person" data-value="${esc(c.participantIds[0])}">Your name and voice</button>` : `<h3>Group members</h3>${participants(c).map(p => `<button data-action="person" data-value="${esc(p.memberId)}">${esc(personName(c,p.memberId))}${svg('edit')}</button>`).join('')}`}</div>` : ''}<label for="microphone-input">Microphone</label>${state.microphones.length ? `<select id="microphone-input" ${!['idle','listening','thinking','speaking'].includes(state.phase) || (active && c.mode === 'group') ? 'disabled' : ''}>${state.microphones.filter(d => d.deviceId !== 'communications').map((d,i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === state.microphoneId ? 'selected' : ''}>${esc(d.label || `Microphone ${i+1}`)}</option>`).join('')}</select>${active && c.mode === 'group' ? '<p class="panel-note">End the call to change the microphone.</p>' : ''}` : '<p class="panel-note">The call will use your default microphone.</p>'}`;
    }
    if (panel === 'settings') body += active ? '<p class="panel-note">End the call to open Admin settings.</p>' : '<a class="admin-link" href="/admin">Admin settings<span aria-hidden="true">→</span></a>';
    if (panel === 'person') {
      const p = c.people.find(p => p.memberId === panelValue);
      title = c.mode === 'solo' ? 'Your name and voice' : 'Member details';
      body = `<form data-form="person"><label for="person-name">Name</label><input id="person-name" data-draft="name" data-owner="${esc(panelValue)}" name="name" maxlength="32" value="${draft(c,'name',panelValue,p?.name)}" autocomplete="off"><button class="primary" type="submit">Save</button></form>${c.mode === 'group' ? `<p class="panel-note">${p?.voiceprintId ? 'Voice registered' : 'Voice not registered'}</p><button data-action="reregister" data-value="${esc(panelValue)}">${p?.voiceprintId ? 'Register voice again' : 'Register voice'}</button><div class="panel-divider"></div><button data-action="replace" data-value="${esc(panelValue)}">Replace member</button><p class="panel-note">Previous contributions will stay in the transcript.</p>` : ''}`;
    }
    if (panel === 'person' && c.mode === 'solo') {
      const p = c.people.find(p=>p.memberId === panelValue);
      body += `<p class="panel-note">${p?.voiceConfirmed ? 'Your confirmed voice is saved for this conversation and microphone.' : 'Confirm your voice when you start talking.'}</p><button data-action="reregister" data-value="${esc(panelValue)}">Set up my voice again</button>`;
    }
    if (panel === 'edit') {
      const line = c.lines.find(l => l.key === panelValue);
      title = 'Edit transcript';
      body = `<form data-form="edit"><label for="edit-speaker">Speaker</label><select id="edit-speaker" name="speaker" data-draft="edit-speaker" data-owner="${esc(panelValue)}">${selectPeople(c,drafts.get(c.id,'edit-speaker',panelValue,line?.speakerId))}</select><label for="edit-text">Message</label><textarea id="edit-text" name="text" data-draft="edit-text" data-owner="${esc(panelValue)}" rows="7" required>${draft(c,'edit-text',panelValue,line?.text)}</textarea><button class="primary" type="submit">Save correction</button></form>`;
    }
    if (panel === 'outline') {
      title = 'Personal outline';
      const chosen = panelValue ?? c.participantIds[0];
      const outline = c.drafts[chosen];
      const hasSpeech = c.lines.some(l => l.role === 'student' && l.speakerId === chosen && l.paragraph);
      body = `${c.mode === 'group' ? `<div class="person-tabs" role="group" aria-label="View personal outline">${peopleForReview(c,drafts).map(p => `<button data-action="outline-person" data-value="${esc(p.memberId)}" aria-pressed="${p.memberId === chosen}">${esc(reviewName(c,p.memberId))}</button>`).join('')}</div>` : ''}${outline ? `<form data-form="outline" data-person="${esc(chosen)}"><p class="panel-note">${outline.status === 'confirmed' ? 'Confirmed' : outline.status === 'needs_review' ? 'The transcript changed. Review this outline.' : 'Review, edit, then confirm.'}</p><label class="sr-only" for="outline-text">Outline for ${esc(personName(c,chosen))}</label><textarea id="outline-text" data-draft="outline" data-owner="${esc(chosen)}" name="text" rows="12" maxlength="6000" required>${draft(c,'outline',chosen,outline.text)}</textarea><div class="record-actions"><button type="submit" name="status" value="draft">Save changes</button><button class="primary" type="submit" name="status" value="confirmed">Confirm outline</button></div></form>` : `<p class="panel-note">${hasSpeech ? 'Create an outline from this person’s contributions.' : 'No contributions from this person yet.'}</p>`}<div class="record-actions"><button data-action="outline" data-value="${esc(chosen)}" ${!hasSpeech || state.pendingOutline ? 'disabled' : ''}>${active ? 'Create outline' : 'Start call & create outline'}</button><button data-action="export-person" data-value="${esc(chosen)}" ${!hasSpeech ? 'disabled' : ''}>Export</button></div>`;
    }
    return `<div class="panel-shade" data-action="close"></div><aside class="side-panel${panel === 'history' ? ' side-panel-left' : ''}" role="dialog" aria-modal="true" aria-labelledby="panel-title"><div class="panel-header"><h2 id="panel-title">${title}</h2><button class="icon-button" data-action="close" aria-label="Close panel">${svg('close')}</button></div><div class="panel-body">${state.error ? `<div class="error-notice" role="alert">${esc(state.error)}</div>` : ''}${body}<p class="draft-error" role="status" ${drafts.error ? '' : 'hidden'}>${esc(drafts.error)}</p></div>${active ? `<div class="panel-call"><span>${state.muted ? 'Mic off' : 'Call in progress'}</span><button data-action="stop">End call</button></div>` : ''}</aside>`;
  }
  function renderEnrollment(c, state) {
    if (c.mode === 'solo') return renderSoloEnrollment(state);
    const people = participants(c), index = people.findIndex(p => p.memberId === state.enrollmentId);
    const name = personName(c,state.enrollmentId);
    return `<section class="enrollment-stage" aria-label="Introduce group members"><span class="step-label">Member ${Math.max(1,index + 1)} of 3</span><h1>${state.phase === 'registering' ? 'Registering your voice' : `Meet ${esc(name)}`}</h1><p>Say your name, then introduce yourself in English for 20 seconds. Take turns so Mimi can learn each voice.</p><label class="sr-only" for="intro-name">Name (optional)</label><input id="intro-name" data-draft="intro-name" data-owner="${esc(state.enrollmentId)}" maxlength="32" value="${draft(c,'intro-name',state.enrollmentId,people[index]?.name)}" placeholder="Your name (or say it in your introduction)" ${state.phase === 'registering' ? 'disabled' : ''}>${state.recording ? `<progress max="20" value="${state.seconds}" aria-label="Recording progress"></progress><p class="progress-label">${state.seconds} / 20 seconds</p><p class="intro-subtitle" aria-live="polite">${esc(state.intro || '')}</p>${state.phase !== 'registering' ? '<button data-action="cancel-enroll">Try again</button>' : ''}` : `<button class="primary start-button" data-action="enroll">${svg('mic')}Start introduction</button>`}</section>`;
  }
  function render() {
    const {conversation:c,state,workspace} = runtime.getSnapshot();
    const active = state.phase !== 'idle', ready = ['listening','thinking','speaking'].includes(state.phase);
    const enrolling = ['enrolling','registering','review-voice','transcribing-voice'].includes(state.phase);
    const busy = ['permission','connecting','ending'].includes(state.phase);
    const hasRecords = c.lines.length > 0;
    const oldScroll = host.querySelector('.conversation-scroll');
    const changed = conversationId !== c.id;
    const nearBottom = !oldScroll || oldScroll.scrollHeight - oldScroll.scrollTop - oldScroll.clientHeight < 70;
    const scrollTop = oldScroll?.scrollTop ?? 0;
    if (changed) { conversationId = c.id; filter = 'all'; textOpen = Boolean(drafts.get(c.id,'message')); }
    if (active) filter = 'all';
    if (active && !voiceStarted) { voiceStarted = Date.now(); inputTimer = setTimeout(renderInputLevel,10000); }
    if (!active) { voiceStarted = 0; clearTimeout(inputTimer); }
    const focused = host.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = focused?.id, focusedAction = focused?.dataset?.action, focusedValue = focused?.dataset?.value;
    const selection = focused && 'selectionStart' in focused ? [focused.selectionStart,focused.selectionEnd] : null;
    panelScroll = host.querySelector('.panel-body')?.scrollTop ?? panelScroll;
    const mimiPhase = state.autoplayBlocked && state.phase === 'speaking' ? 'paused' : ['thinking','speaking'].includes(state.phase) ? state.phase : state.muted ? 'muted' : state.phase;
    const status = state.phase === 'ending' ? 'Ending call' : busy ? state.phase === 'permission' ? 'Allow microphone access' : 'Connecting to Mimi' : mimiPhase === 'thinking' ? 'Mimi is thinking' : mimiPhase === 'speaking' ? 'Mimi is speaking' : mimiPhase === 'paused' ? 'Play Mimi’s reply' : state.muted ? 'Mic off' : state.engagement === 'next' && c.mode === 'group' ? 'Ask your question' : c.mode === 'group' ? 'Listening to your discussion' : state.engagement === null ? 'Listening only' : 'Mimi is listening';
    const lines = c.lines.filter(l => filter === 'all' || (filter === 'unknown' ? l.role === 'student' && !l.speakerId : l.speakerId === filter || l.targetPersonId === filter));
    const hasUnknown = c.lines.some(l => l.role === 'student' && !l.speakerId);
    const message = drafts.get(c.id,'message');
    const awaiting = c.mode === 'group' && state.engagement === 'next';
    const answering = ['thinking','speaking'].includes(state.phase);
    host.innerHTML = `<main class="mimi-app ${active ? 'call-active' : ''} ${!hasRecords && !enrolling ? 'welcome-view' : ''} ${textOpen ? 'keyboard-open' : ''}"><div class="main-surface" ${panel ? 'inert' : ''}>
      ${header(active)}
      ${modeTabs(c.mode,active)}
      <section class="conversation-space" aria-label="Voice conversation">
        ${active && hasRecords && !enrolling ? `<div class="call-presence">${portrait(true,mimiPhase)}</div>` : ''}
        ${c.mode === 'group' ? `<div class="participants" aria-label="Group members">${!active && hasRecords ? `<button data-action="filter" data-value="all" aria-pressed="${filter === 'all'}">Everyone</button>` : ''}${participants(c).map(p => !active && hasRecords ? `<button data-action="filter" data-value="${esc(p.memberId)}" aria-pressed="${filter === p.memberId}">${esc(personName(c,p.memberId))}</button>` : `<span class="participant ${state.activeSpeaker === p.memberId ? 'current' : ''}">${esc(personName(c,p.memberId))}${p.voiceprintId ? '<span class="member-ready" aria-label="Voice registered">·</span>' : ''}</span>`).join('')}${!active && hasUnknown ? `<button data-action="filter" data-value="unknown" aria-pressed="${filter === 'unknown'}">Unassigned</button>` : ''}</div>` : ''}
        <div class="conversation-scroll">
          ${enrolling ? renderEnrollment(c,state) : hasRecords ? `<ol class="conversation-lines" aria-label="Transcript">${lines.map(l => `<li class="message ${l.role === 'hermes' ? 'coach-message' : 'student-message'}"><div class="message-heading"><span>${esc(l.role === 'hermes' ? 'Mimi' : personName(c,l.speakerId))}</span>${!active && l.role === 'student' ? `<button class="icon-button message-edit" data-action="edit" data-value="${esc(l.key)}" aria-label="Edit message from ${esc(personName(c,l.speakerId))}" title="Edit transcript">${svg('edit')}</button>` : ''}</div><p>${esc(l.text)}</p>${!l.paragraph ? `<span class="message-note">${active ? 'Transcribing…' : 'Incomplete transcript'}</span>` : ''}</li>`).join('') || '<li class="empty-filter">No contributions from this person yet.</li>'}</ol>` : `<div class="empty-conversation">${portrait(false,mimiPhase)}<h1 ${active ? 'hidden' : ''}>${active ? c.mode === 'group' ? 'Start your discussion' : 'Go ahead, I’m listening' : c.mode === 'group' ? 'Discuss together' : 'Practice English with Mimi'}</h1>${!active && c.mode === 'group' && participants(c).some(p => !p.voiceprintId) ? '<p>Introduce yourselves one at a time, then discuss freely.</p>' : ''}</div>`}
        </div>
        <div class="conversation-bottom">
          ${state.error ? `<div class="error-notice" role="alert">${esc(state.error)}${/microphone|audio capture/i.test(state.error) ? '<button class="text-button" data-action="settings">Check microphone</button>' : ''}</div>` : ''}
          ${!state.saved ? `<div class="error-notice" role="alert">${esc(state.storageError || 'Conversations have not been saved')}<button class="text-button" data-action="export-all">Export all conversations</button></div>` : ''}
          ${state.autoplayBlocked ? '<button class="sound-button" data-action="sound">Play Mimi’s voice</button>' : ''}
          <p class="draft-error" role="status" ${drafts.error ? '' : 'hidden'}>${esc(drafts.error)}</p>
          ${active && !enrolling && c.mode === 'solo' && state.voiceStatus ? `<p class="voice-protection-status" role="status">${esc(state.voiceStatus)}</p>` : ''}
          ${active && !enrolling ? `<div class="voice-feedback" data-phase="${mimiPhase}"><span class="input-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span role="status">${esc(status)}</span></div><div class="input-hint" id="input-hint" hidden><span>No sound detected</span><button class="text-button" data-action="settings">Check microphone</button></div>` : ''}
          ${textOpen && !enrolling ? `<div class="composer-area"><form data-form="text" class="text-composer">${c.mode === 'group' ? `<div class="composer-author"><label for="text-speaker">From</label><select id="text-speaker" name="speaker" data-draft="message-speaker">${selectPeople(c,drafts.get(c.id,'message-speaker','','unknown'),true)}</select></div>` : ''}<div class="composer-entry"><label class="sr-only" for="message-text">Message Mimi</label><textarea id="message-text" name="text" data-draft="message" rows="1" maxlength="7000" required placeholder="Message Mimi…" ${!active ? 'aria-describedby="composer-hint"' : ''}>${esc(message)}</textarea><button type="submit" class="send-button" ${busy || submitting || !message.trim() ? 'disabled' : ''} aria-label="${active ? 'Send message' : 'Send message and start voice call'}" title="${active ? 'Send message' : 'Send message and start voice call'}">${svg('send')}</button></div></form>${!active ? '<p class="composer-hint" id="composer-hint">Sending starts a voice call with Mimi.</p>' : ''}</div>` : ''}
          <div class="call-controls">${active ? `${ready ? `<button class="control" data-action="mute" aria-label="${state.muted ? 'Unmute' : 'Mute'}" aria-pressed="${state.muted}" title="${state.muted ? 'Unmute' : 'Mute'}">${svg(state.muted ? 'muted' : 'mic')}<span>${state.muted ? 'Unmute' : 'Mute'}</span></button>${c.mode === 'group' ? `<button class="coach-control ${awaiting ? 'is-waiting' : ''}" data-action="${awaiting || answering ? 'listen' : 'ask'}">${awaiting ? 'Cancel question' : answering ? 'Stop reply' : 'Ask Mimi'}</button>` : state.engagement === null ? '<button class="coach-control" data-action="ask">Resume replies</button>' : ''}` : ''}<button class="control end-control" data-action="stop" aria-label="${busy && state.phase !== 'ending' ? 'Cancel connection' : 'End call'}" title="End call" ${state.phase === 'ending' ? 'disabled' : ''}>${svg('end')}<span>${busy && state.phase !== 'ending' ? 'Cancel' : 'End call'}</span></button>` : textOpen ? '' : `<button class="primary start-button" data-action="start">${svg('wave')}${hasRecords ? 'Continue talking' : 'Start talking'}</button>`}${!enrolling ? `<button class="keyboard-button" data-action="text" aria-label="${textOpen ? active ? 'Close text input' : 'Back to voice' : 'Type a message'}" aria-expanded="${textOpen}" ${textOpen ? 'aria-controls="message-text"' : ''} title="${textOpen ? active ? 'Close text input' : 'Back to voice' : 'Type a message'}">${svg(textOpen ? active ? 'down' : 'wave' : 'text')}<span>${textOpen ? active ? 'Close text' : 'Back to voice' : active ? 'Type' : 'Type a message'}</span></button>` : ''}</div>
          ${!active && hasRecords ? `<div class="after-call"><span>${state.saved ? 'Saved on this device' : 'Not saved'}</span><button class="text-button" data-action="outline-panel">Personal outline</button></div>` : ''}
        </div>
      </section></div>${renderPanel(c,state,workspace)}</main>`;
    updateViewport();
    const scroll = host.querySelector('.conversation-scroll');
    if (scroll) scroll.scrollTop = changed || nearBottom ? scroll.scrollHeight : scrollTop;
    const body = host.querySelector('.panel-body'); if (body) body.scrollTop = panelScroll;
    if (focusedId) {
      const el = host.querySelector(`#${focusedId}`);
      if (el) { el.focus({preventScroll:true}); if (selection && el.setSelectionRange && el.tagName !== 'SELECT' && !['progress','meter'].includes(el.tagName.toLowerCase())) el.setSelectionRange(...selection); }
    } else if (focusedAction) {
      [...host.querySelectorAll('[data-action]')].find(el => el.dataset.action === focusedAction && el.dataset.value === focusedValue)?.focus({preventScroll:true});
    }
    renderInputLevel();
  }
  function updateComposer() {
    const textarea = host.querySelector('#message-text');
    if (!textarea) return;
    const {state} = runtime.getSnapshot();
    const send = host.querySelector('.send-button');
    send.disabled = submitting || ['permission','connecting','ending'].includes(state.phase) || !textarea.value.trim();
    // Re-measure after text, viewport, or transcript changes, including shrink.
    const top = textarea.scrollTop;
    textarea.style.height = '0px';
    textarea.style.height = `${textarea.scrollHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > textarea.clientHeight ? 'auto' : 'hidden';
    textarea.scrollTop = top;
  }
  function updateViewport() {
    const viewport = window.visualViewport;
    const available = textOpen && !panel && viewport?.scale === 1 ? Math.min(innerHeight,viewport.height) : innerHeight;
    host.style.setProperty('--app-height',`${available}px`);
    host.toggleAttribute('data-compact-viewport',textOpen && available < 480);
    updateComposer();
  }
  function renderInputLevel() {
    const {state} = runtime.getSnapshot();
    const volume = state.muted ? 0 : Math.min(1,state.inputLevel / 150);
    host.querySelectorAll('.input-wave,.mimi-signal').forEach(signal => [...signal.children].forEach((bar,i) => { bar.style.setProperty('--bar-height',`${3 + volume * [8,16,22,13,6][i]}px`); }));
    host.querySelector('.mimi-portrait')?.style.setProperty('--input-spread',`${2 + volume * 10}px`);
    const hint = host.querySelector('#input-hint');
    if (hint) hint.hidden = textOpen || state.muted || state.hasInput || state.phase !== 'listening' || Date.now() - voiceStarted < 10000;
  }
  async function click(event) {
    const button = event.target.closest('[data-action]');
    if (!button || !host.contains(button) || button.disabled) return;
    const action = button.dataset.action, value = button.dataset.value;
    const {conversation:c,state,workspace} = runtime.getSnapshot();
    if (action === 'stop' && state.phase === 'ending') return;
    const idleOnly = ['new','mode','select','person','reregister','replace','edit','filter','outline-panel'];
    if (state.phase !== 'idle' && idleOnly.includes(action)) return;
    try {
      if (action === 'start') { filter = 'all'; await runtime.start(); }
      if (action === 'stop') { panel = null; await runtime.stop(); }
      if (action === 'mode' && value !== c.mode) {
        panel = null;
        const existing = [...workspace.conversations].reverse().find(x => x.mode === value);
        if (existing) await runtime.selectConversation(existing.id);
        else await runtime.newConversation(value,{keepEmpty:drafts.has(c.id)});
      }
      if (action === 'new') { closePanel(); await runtime.newConversation(c.mode,{keepEmpty:drafts.has(c.id)}); }
      if (action === 'history') openPanel('history');
      if (action === 'settings') openPanel('settings');
      if (action === 'person') openPanel('person',value);
      if (action === 'close') closePanel();
      if (action === 'select') { closePanel(); await runtime.selectConversation(value); }
      if (action === 'enroll') await runtime.enroll();
      if (action === 'cancel-enroll') await runtime.cancelEnrollment();
      if (action === 'confirm-voice') await runtime.confirmVoice();
      if (action === 'reject-voice') await runtime.retryVoice();
      if (action === 'mute') await runtime.toggleMute();
      if (action === 'listen') await runtime.listenOnly();
      if (action === 'ask') await runtime.ask();
      if (action === 'sound') await runtime.enableSound();
      if (action === 'reregister') { closePanel(); await runtime.reregister(value); }
      if (action === 'replace') { closePanel(); await runtime.replace(value); }
      if (action === 'edit') openPanel('edit',value);
      if (action === 'filter') { filter = value; render(); }
      if (action === 'text') { textOpen = !textOpen; render(); if (textOpen) host.querySelector('#message-text')?.focus({preventScroll:true}); }
      if (action === 'outline-panel') openPanel('outline',filter !== 'all' && filter !== 'unknown' ? filter : c.participantIds[0]);
      if (action === 'outline-person') { panelValue = value; panelScroll = 0; render(); }
      if (action === 'outline') { closePanel(); await runtime.outline(value); }
      if (action === 'export') download(exportConversation(c),'Mimi-transcript.txt');
      if (action === 'export-person') download(exportConversation(c,value),'Mimi-personal-outline.txt');
      if (action === 'export-all') download(runtime.exportRaw(),'Mimi-conversations.json','application/json');
    } catch (error) { runtime.report(error); }
  }
  async function submit(event) {
    const form = event.target.closest('form'); if (!form) return;
    event.preventDefault(); if (submitting) return;
    const data = new FormData(form), {conversation:c} = runtime.getSnapshot();
    const owner = panelValue;
    try {
      if (form.dataset.form === 'person') {
        await runtime.rename(owner,String(data.get('name') ?? '')); drafts.clear(c.id,'name',owner); closePanel();
      }
      if (form.dataset.form === 'edit') {
        await runtime.correct(owner,data.get('speaker') === 'unknown' ? null : data.get('speaker'),String(data.get('text')));
        drafts.clear(c.id,'edit-speaker',owner); drafts.clear(c.id,'edit-text',owner); closePanel();
      }
      if (form.dataset.form === 'outline') {
        const person = form.dataset.person;
        runtime.saveOutline(person,String(data.get('text')),event.submitter?.value ?? 'draft');
        drafts.clear(c.id,'outline',person); render();
      }
      if (form.dataset.form === 'text') {
        const text = String(data.get('text')); if (!text.trim()) return;
        if (['permission','connecting','ending'].includes(runtime.getSnapshot().state.phase)) return;
        const speaker = data.get('speaker');
        const person = c.mode === 'solo' ? c.participantIds[0] : c.participantIds.includes(speaker) ? speaker : null;
        submitting = true;
        // sendText stores the utterance synchronously before connecting. Clear
        // only after it is in the conversation, even if the voice reply fails.
        const sent = runtime.sendText(text,person);
        if (runtime.getSnapshot().conversation.lines.length > c.lines.length) { drafts.clear(c.id,'message'); drafts.clear(c.id,'message-speaker'); }
        render(); host.querySelector('#message-text')?.focus({preventScroll:true}); await sent;
      }
    } catch (error) { runtime.report(error); }
    finally { submitting = false; render(); }
  }
  function input(event) {
    const el = event.target;
    if (el.dataset.draft) {
      drafts.set(runtime.getSnapshot().conversation.id,el.dataset.draft,el.dataset.owner ?? '',el.value);
      host.querySelectorAll('.draft-error').forEach(node => { node.textContent = drafts.error; node.hidden = !drafts.error; });
      if (el.id === 'message-text') updateComposer();
    }
  }
  function change(event) {
    input(event);
    if (event.target.id === 'microphone-input') void runtime.selectMicrophone(event.target.value).catch(runtime.report);
    if (event.target.id === 'intro-name') {
      const {conversation:c,state} = runtime.getSnapshot(), name = event.target.value, owner = state.enrollmentId;
      void runtime.rename(owner,name).then(() => { drafts.clear(c.id,'intro-name',owner); render(); }).catch(runtime.report);
    }
  }
  function keydown(event) {
    if (!panel && event.target.id === 'message-text') {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault(); textOpen = false; render();
        host.querySelector('[data-action="text"]')?.focus({preventScroll:true});
      }
      // Software keyboards keep their native return key for a new line.
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && matchMedia('(hover: hover) and (pointer: fine)').matches) {
        event.preventDefault();
        const form = event.target.form, send = form.querySelector('.send-button');
        if (!send.disabled) form.requestSubmit(send);
      }
      return;
    }
    if (!panel) return;
    if (event.key === 'Escape') { event.preventDefault(); closePanel(); return; }
    if (event.key === 'Tab') {
      const items = [...host.querySelectorAll('.side-panel a[href],.side-panel button:not(:disabled),.side-panel input:not(:disabled),.side-panel textarea,.side-panel select:not(:disabled)')];
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }
  const pagehide = () => runtime.pagehide();
  host.addEventListener('click',click); host.addEventListener('submit',submit); host.addEventListener('input',input);
  host.addEventListener('change',change); host.addEventListener('keydown',keydown); window.addEventListener('pagehide',pagehide);
  window.addEventListener('resize',updateViewport);
  window.visualViewport?.addEventListener('resize',updateViewport);
  const unsubscribe = runtime.subscribe(kind => kind === 'audio' ? renderInputLevel() : render()); render();
  return () => {
    clearTimeout(inputTimer); unsubscribe(); runtime.destroy();
    host.removeEventListener('click',click); host.removeEventListener('submit',submit); host.removeEventListener('input',input);
    host.removeEventListener('change',change); host.removeEventListener('keydown',keydown); window.removeEventListener('pagehide',pagehide);
    window.removeEventListener('resize',updateViewport);
    window.visualViewport?.removeEventListener('resize',updateViewport);
  };
}
