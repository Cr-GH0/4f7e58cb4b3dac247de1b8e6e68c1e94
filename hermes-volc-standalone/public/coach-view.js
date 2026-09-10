import { signOut } from './sign-out.js';
import { createVoiceRuntime } from './voice-runtime.js';
import { participants, personName, exportConversation } from './conversation.js';
import { createInputDrafts } from './input-drafts.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  history: '<path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2"/>',
  settings: '<path d="m9 3-.7 2.4-2.3 1L3.8 6 2 9.2l1.7 1.7v2.2L2 14.8 3.8 18l2.2-.4 2.3 1L9 21h6l.7-2.4 2.3-1 2.2.4 1.8-3.2-1.7-1.7v-2.2L22 9.2 20.2 6l-2.2.4-2.3-1L15 3Z"/><circle cx="12" cy="12" r="3"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  wave: '<path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4"/>',
  end: '<path d="M4 15v-3c4-4 12-4 16 0v3l-4 1-1-3a9 9 0 0 0-6 0l-1 3Z"/>',
  send: '<path d="M12 20V4m-7 7 7-7 7 7"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-4-4L5 15l-1 5Z"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
};
const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
const portrait = (compact = false, phase = '') => `<div class="mimi-portrait${compact ? ' compact' : ''}" data-phase="${phase}"><img src="/mimi.png" width="288" height="288" alt="Mimi, your English teaching assistant" fetchpriority="high" draggable="false"><span class="mimi-signal" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span></div>`;
const header = (active = false) => `<header class="app-header"><button data-action="history" class="header-button" ${active ? 'disabled' : ''}>${svg('history')}<span>History</span></button><span class="wordmark">Mimi</span><button data-action="settings" class="header-button">Settings</button></header>`;

// The auto-send pause is served per deployment so it can be tuned without a release.
let autoSendPauseMs = null;
async function loadAutoSendPause() {
  if (autoSendPauseMs !== null) return;
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    const value = await response.json();
    autoSendPauseMs = Number.isFinite(value?.autoSendPauseMs) && value.autoSendPauseMs >= 0 ? value.autoSendPauseMs : 1200;
  } catch { autoSendPauseMs = 1200; }
}
const sendPause = () => autoSendPauseMs ?? 1200;

/** React owns the host; the same conversation UI also mounts in the standalone app. */
export function mountCoach(host, options) {
  const runtime = createVoiceRuntime(options);
  const drafts = createInputDrafts(options.storage ?? globalThis.localStorage);
  let panel = null, panelValue = null, filter = 'all';
  let focusReturn = null, panelScroll = 0, conversationId = null;
  let submitting = false, composing = false, autoTimer = null;
  let viewportFrame = null;
  void loadAutoSendPause();
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
  function selectPeople(c, selected) {
    return `<option value="unknown" ${!selected || selected === 'unknown' ? 'selected' : ''}>Unassigned</option>` + c.people.map(p => `<option value="${esc(p.memberId)}" ${p.memberId === selected ? 'selected' : ''}>${esc(personName(c,p.memberId))}</option>`).join('');
  }
  function renderPanel(c, state, workspace) {
    if (!panel) return '';
    const active = state.phase !== 'idle';
    let title = '', body = '';
    if (panel === 'history') {
      title = 'History';
      body = `<button class="new-conversation" data-action="new" ${active ? 'disabled' : ''}>${svg('plus')}New conversation</button><div class="history-list">${[...workspace.conversations].reverse().map(x => `<button data-action="select" data-value="${esc(x.id)}" aria-current="${x.id === c.id}" ${active ? 'disabled' : ''}><strong>${x.mode === 'group' ? participants(x).map(p => esc(personName(x,p.memberId))).join(', ') : 'Solo practice'}</strong><span>${esc(new Date(x.updatedAt).toLocaleString('en-US',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}))}</span></button>`).join('')}</div><p class="panel-note">Conversations are saved in this browser on this device.</p>`;
    }
    if (panel === 'settings') {
      title = 'Settings';
      body = `<div class="settings-actions">${active ? '' : `<button data-action="person" data-value="${esc(c.participantIds[0])}">Your name${svg('edit')}</button>`}${c.lines.length ? '<button data-action="export">Export conversation</button>' : ''}<button data-action="export-all">Export all conversations</button></div>${active ? '<p class="panel-note">End the practice to open Admin settings.</p>' : '<a class="admin-link" href="/admin">Admin settings<span aria-hidden="true">→</span></a>'}`;
    }
    if (panel === 'person') {
      const p = c.people.find(p => p.memberId === panelValue);
      title = 'Your name';
      body = `<form data-form="person"><label for="person-name">Name</label><input id="person-name" data-draft="name" data-owner="${esc(panelValue)}" name="name" maxlength="32" value="${draft(c,'name',panelValue,p?.name)}" autocomplete="off"><button class="primary" type="submit">Save</button></form>${options.account ? '<p class="panel-note">Your name is used across the conversations in your Mimi account.</p><button data-action="account">My account</button>' : ''}`;
    }
    if (panel === 'edit') {
      const line = c.lines.find(l => l.key === panelValue);
      title = 'Edit transcript';
      body = `<form data-form="edit"><label for="edit-speaker">Speaker</label><select id="edit-speaker" name="speaker" data-draft="edit-speaker" data-owner="${esc(panelValue)}">${selectPeople(c,drafts.get(c.id,'edit-speaker',panelValue,line?.speakerId))}</select><label for="edit-text">Message</label><textarea id="edit-text" name="text" data-draft="edit-text" data-owner="${esc(panelValue)}" rows="7" required>${draft(c,'edit-text',panelValue,line?.text)}</textarea><button class="primary" type="submit">Save correction</button></form>`;
    }
    if (panel === 'outline') {
      title = 'Personal outline';
      const chosen = c.participantIds[0];
      const outline = c.drafts[chosen];
      const hasSpeech = c.lines.some(l => l.role === 'student' && l.speakerId === chosen && l.paragraph);
      body = `${outline ? `<form data-form="outline" data-person="${esc(chosen)}"><p class="panel-note">${outline.status === 'confirmed' ? 'Confirmed' : outline.status === 'needs_review' ? 'The transcript changed. Review this outline.' : 'Review, edit, then confirm.'}</p><label class="sr-only" for="outline-text">Your outline</label><textarea id="outline-text" data-draft="outline" data-owner="${esc(chosen)}" name="text" rows="12" maxlength="6000" required>${draft(c,'outline',chosen,outline.text)}</textarea><div class="record-actions"><button type="submit" name="status" value="draft">Save changes</button><button class="primary" type="submit" name="status" value="confirmed">Confirm outline</button></div></form>` : `<p class="panel-note">${hasSpeech ? 'Create an outline from your contributions.' : 'No contributions yet.'}</p>`}<div class="record-actions"><button data-action="outline" data-value="${esc(chosen)}" ${!hasSpeech || state.pendingOutline ? 'disabled' : ''}>${active ? 'Create outline' : 'Start practice & create outline'}</button><button data-action="export-person" data-value="${esc(chosen)}" ${!hasSpeech ? 'disabled' : ''}>Export</button></div>`;
    }
    return `<div class="panel-shade" data-action="close"></div><aside class="side-panel${panel === 'history' ? ' side-panel-left' : ''}" role="dialog" aria-modal="true" aria-labelledby="panel-title"><div class="panel-header"><h2 id="panel-title">${title}</h2><button class="icon-button" data-action="close" aria-label="Close panel">${svg('close')}</button></div><div class="panel-body">${state.error ? `<div class="error-notice" role="alert">${esc(state.error)}</div>` : ''}${body}<p class="draft-error" role="status" ${drafts.error ? '' : 'hidden'}>${esc(drafts.error)}</p></div>${active ? `<div class="panel-call"><span>Call in progress</span><button data-action="stop">End practice</button></div>` : ''}</aside>`;
  }
  function render() {
    const {conversation:c,state,workspace} = runtime.getSnapshot();
    const active = state.phase !== 'idle', busy = ['connecting','ending'].includes(state.phase);
    const hasRecords = c.lines.length > 0;
    const oldScroll = host.querySelector('.conversation-scroll');
    const changed = conversationId !== c.id;
    const nearBottom = !oldScroll || oldScroll.scrollHeight - oldScroll.scrollTop - oldScroll.clientHeight < 70;
    const scrollTop = oldScroll?.scrollTop ?? 0;
    if (changed) { conversationId = c.id; filter = 'all'; clearTimeout(autoTimer); }
    if (active) filter = 'all';
    const focused = host.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = focused?.id, focusedAction = focused?.dataset?.action, focusedValue = focused?.dataset?.value;
    const selection = focused && 'selectionStart' in focused ? [focused.selectionStart,focused.selectionEnd] : null;
    panelScroll = host.querySelector('.panel-body')?.scrollTop ?? panelScroll;
    const mimiPhase = state.autoplayBlocked && state.phase === 'speaking' ? 'paused' : ['listening','thinking','speaking'].includes(state.phase) ? state.phase : '';
    const status = state.phase === 'ending' ? 'Ending practice' : state.phase === 'connecting' ? (state.connectionStep || 'Connecting to Mimi') : mimiPhase === 'thinking' ? 'Mimi is thinking' : mimiPhase === 'speaking' ? 'Mimi is speaking' : mimiPhase === 'paused' ? 'Play Mimi’s reply' : 'Mimi is listening';
    const lines = c.lines.filter(l => filter === 'all' || (filter === 'unknown' ? l.role === 'student' && !l.speakerId : l.speakerId === filter || l.targetPersonId === filter));
    const message = drafts.get(c.id,'message');
    host.innerHTML = `<main class="mimi-app ${active ? 'call-active' : ''} ${!hasRecords ? 'welcome-view' : ''}"><div class="main-surface" ${panel ? 'inert' : ''}>
      ${header(active)}
      ${options.account ? `<p class="account-label">${esc(options.account.accountName)} · ${esc(personName(c,c.participantIds[0]))} <button type="button" class="text-button" data-action="logout">Sign out</button></p>` : ''}
      <section class="conversation-space" aria-label="Conversation with Mimi">
        ${active && hasRecords ? `<div class="call-presence">${portrait(true,mimiPhase)}</div>` : ''}
        <div class="conversation-scroll">
          ${hasRecords ? `<ol class="conversation-lines" aria-label="Transcript">${lines.map(l => `<li class="message ${l.role === 'hermes' ? 'coach-message' : 'student-message'}"><div class="message-heading"><span>${esc(l.role === 'hermes' ? 'Mimi' : personName(c,l.speakerId))}</span>${!active && l.role === 'student' ? `<button class="icon-button message-edit" data-action="edit" data-value="${esc(l.key)}" aria-label="Edit message from ${esc(personName(c,l.speakerId))}" title="Edit transcript">${svg('edit')}</button>` : ''}</div><p>${esc(l.text)}</p>${!l.paragraph ? `<span class="message-note">${active ? 'Transcribing…' : 'Incomplete transcript'}</span>` : ''}</li>`).join('') || '<li class="empty-filter">No contributions yet.</li>'}</ol>` : `<div class="empty-conversation">${portrait(false,mimiPhase)}<h1 ${active ? 'hidden' : ''}>Practice English with Mimi</h1></div>`}
        </div>
        <div class="conversation-bottom">
          ${state.error ? `<div class="error-notice" role="alert">${esc(state.error)}</div>` : ''}
          ${!state.saved ? `<div class="error-notice" role="alert">${esc(state.storageError || 'Conversations have not been saved')}<button class="text-button" data-action="export-all">Export all conversations</button></div>` : ''}
          ${state.autoplayBlocked ? '<button class="sound-button" data-action="sound">Play Mimi’s voice</button>' : ''}
          <p class="draft-error" role="status" ${drafts.error ? '' : 'hidden'}>${esc(drafts.error)}</p>
          ${active ? `<div class="voice-feedback" data-phase="${mimiPhase || state.phase}"><span class="input-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span role="status">${esc(status)}</span></div>` : ''}
          <div class="composer-area"><form data-form="text" class="text-composer"><div class="composer-entry"><label class="sr-only" for="message-text">Message Mimi</label><textarea id="message-text" name="text" data-draft="message" rows="1" maxlength="7000" required placeholder="Message Mimi…">${esc(message)}</textarea><button type="submit" class="send-button" ${submitting || busy || !message.trim() ? 'disabled' : ''} aria-label="Send message" title="Send message">${svg('send')}</button></div></form><p class="composer-hint">Type, or use your voice keyboard — it sends after a pause.</p></div>
          <div class="call-controls">${active ? `<button class="control end-control" data-action="stop" aria-label="${state.phase === 'connecting' ? 'Cancel connection' : 'End practice'}" title="End practice" ${state.phase === 'ending' ? 'disabled' : ''}>${svg('end')}<span>${state.phase === 'connecting' ? 'Cancel' : 'End practice'}</span></button>` : `<button class="primary start-button" data-action="start">${svg('wave')}${hasRecords ? 'Continue practice' : 'Start practice'}</button>`}</div>
          ${!active && hasRecords ? `<div class="after-call"><span>${state.saved ? 'Saved on this device' : 'Not saved'}</span><button class="text-button" data-action="outline-panel">Organize my outline</button></div>` : ''}
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
    scheduleViewport();
  }
  function updateComposer() {
    const textarea = host.querySelector('#message-text');
    if (!textarea) return;
    const {state} = runtime.getSnapshot();
    const send = host.querySelector('.send-button');
    send.disabled = submitting || ['connecting','ending'].includes(state.phase) || !textarea.value.trim();
    // Re-measure after text, viewport, or transcript changes, including shrink.
    const top = textarea.scrollTop;
    const caretAtEnd = document.activeElement === textarea && textarea.selectionStart === textarea.value.length && textarea.selectionEnd === textarea.value.length;
    const transcript = host.querySelector('.conversation-scroll');
    const atBottom = transcript && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 70;
    textarea.style.height = '0px';
    textarea.style.height = `${textarea.scrollHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > textarea.clientHeight ? 'auto' : 'hidden';
    textarea.scrollTop = caretAtEnd ? textarea.scrollHeight : top;
    if (atBottom) transcript.scrollTop = transcript.scrollHeight;
  }
  function updateViewport() {
    const viewport = window.visualViewport;
    const unzoomed = viewport && Math.abs(viewport.scale - 1) < .01;
    const available = unzoomed ? Math.min(innerHeight,viewport.height) : innerHeight;
    const scroll = host.querySelector('.conversation-scroll');
    const atBottom = scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 70;
    const editing = host.contains(document.activeElement) && document.activeElement.matches('textarea,input');
    host.dataset.coachViewport = '';
    host.dataset.compactViewport = String(available < 520 || (editing && innerHeight - available > 120));
    host.style.setProperty('--app-height',`${available}px`);
    // iOS may pan the visual viewport when the keyboard opens, without
    // resizing or scrolling the layout viewport that fixed elements use.
    host.style.setProperty('--app-offset-top',`${unzoomed ? viewport.offsetTop : 0}px`);
    updateComposer();
    if (atBottom) scroll.scrollTop = scroll.scrollHeight;
  }
  function scheduleViewport() {
    if (viewportFrame !== null) return;
    viewportFrame = requestAnimationFrame(() => { viewportFrame = null; updateViewport(); });
  }
  // The composer sends itself after a typing pause, so a phone voice keyboard
  // that drops text into the box needs no extra tap. Only user input (re)arms
  // the timer: restoring a saved draft must not send it by itself.
  function scheduleAutoSend() {
    clearTimeout(autoTimer);
    const textarea = host.querySelector('#message-text');
    if (!composing && textarea && textarea.value.trim()) autoTimer = setTimeout(autoSend, sendPause());
  }
  async function autoSend() {
    if (submitting || composing) return;
    const textarea = host.querySelector('#message-text');
    if (!textarea || !textarea.value.trim()) return;
    if (['connecting','ending'].includes(runtime.getSnapshot().state.phase)) { scheduleAutoSend(); return; }
    await deliverComposer();
  }
  async function deliverComposer() {
    if (submitting || composing) return;
    const textarea = host.querySelector('#message-text');
    if (!textarea || !textarea.value.trim()) return;
    const {conversation:c,state} = runtime.getSnapshot();
    if (['connecting','ending'].includes(state.phase)) return;
    clearTimeout(autoTimer);
    const text = textarea.value, before = c.lines.length;
    let delivered = false;
    submitting = true;
    try {
      // sendText joins the room when needed and stores the utterance before its
      // spoken reply resolves. Clear the draft only once it is in the transcript.
      const sent = runtime.sendText(text,c.participantIds[0]);
      if (runtime.getSnapshot().conversation.lines.length > before) { drafts.clear(c.id,'message'); delivered = true; render(); }
      host.querySelector('#message-text')?.focus({preventScroll:true});
      await sent;
      if (!delivered && runtime.getSnapshot().conversation.lines.length > before) { drafts.clear(c.id,'message'); delivered = true; render(); }
    } catch (error) { runtime.report(error); }
    finally { submitting = false; render(); if (delivered) scheduleAutoSend(); }
  }
  async function click(event) {
    const button = event.target.closest('[data-action]');
    if (!button || !host.contains(button) || button.disabled) return;
    const action = button.dataset.action, value = button.dataset.value;
    const {conversation:c,state,workspace} = runtime.getSnapshot();
    if (action === 'stop' && state.phase === 'ending') return;
    const idleOnly = ['new','select','person','edit','outline-panel'];
    if (state.phase !== 'idle' && idleOnly.includes(action)) return;
    try {
      if (action === 'logout') { button.disabled = true; clearTimeout(autoTimer); await signOut({ fetchFn: options.fetchFn, beforeLeave: () => runtime.pagehide() }); return; }
      if (action === 'start') { filter = 'all'; await runtime.start(); }
      if (action === 'account' && state.phase === 'idle') { await options.onAccount?.(); return; }
      if (action === 'stop') { panel = null; await runtime.stop(); }
      if (action === 'new') { closePanel(); await runtime.newConversation(); }
      if (action === 'history') openPanel('history');
      if (action === 'settings') openPanel('settings');
      if (action === 'person') openPanel('person',value);
      if (action === 'close') closePanel();
      if (action === 'select') { closePanel(); await runtime.selectConversation(value); }
      if (action === 'sound') await runtime.enableSound();
      if (action === 'edit') openPanel('edit',value);
      if (action === 'filter') { filter = value; render(); }
      if (action === 'outline-panel') openPanel('outline');
      if (action === 'outline') { closePanel(); await runtime.outline(value); }
      if (action === 'export') download(exportConversation(c),'Mimi-transcript.txt');
      if (action === 'export-person') download(exportConversation(c,value),'Mimi-personal-outline.txt');
      if (action === 'export-all') download(runtime.exportRaw(),'Mimi-conversations.json','application/json');
    } catch (error) { runtime.report(error); }
  }
  async function submit(event) {
    const form = event.target.closest('form'); if (!form) return;
    event.preventDefault(); if (submitting || composing) return;
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
      if (form.dataset.form === 'text') await autoSend();
    } catch (error) { runtime.report(error); }
  }
  function input(event) {
    const el = event.target;
    if (el.dataset.draft) {
      drafts.set(runtime.getSnapshot().conversation.id,el.dataset.draft,el.dataset.owner ?? '',el.value);
      host.querySelectorAll('.draft-error').forEach(node => { node.textContent = drafts.error; node.hidden = !drafts.error; });
      if (el.id === 'message-text') { updateComposer(); clearTimeout(autoTimer); if (!event.isComposing) scheduleAutoSend(); }
    }
  }
  function compositionStart(event) {
    if (event.target.id === 'message-text') { composing = true; clearTimeout(autoTimer); }
  }
  function compositionEnd(event) {
    if (event.target.id === 'message-text') { composing = false; input(event); }
  }
  function change(event) {
    input(event);
  }
  function keydown(event) {
    if (!panel && event.target.id === 'message-text') {
      if (composing || event.isComposing || event.keyCode === 229) return;
      // Enter sends at once; Shift+Enter adds a new line. Composition keys from
      // voice keyboards pass through untouched.
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void autoSend(); }
      return;
    }
    if (!panel) return;
    if (event.key === 'Escape') { event.preventDefault(); closePanel(); return; }
    if (event.key === 'Tab') {
      const items = [...host.querySelectorAll('.side-panel a[href],.side-panel button:not(:disabled),.side-panel input:not(:disabled),.side-panel textarea,.side-panel select:not(:disabled)')];
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }
  const pagehide = () => runtime.pagehide();
  host.addEventListener('click',click); host.addEventListener('submit',submit); host.addEventListener('input',input);
  host.addEventListener('change',change); host.addEventListener('keydown',keydown); window.addEventListener('pagehide',pagehide);
  host.addEventListener('compositionstart',compositionStart);
  host.addEventListener('compositionend',compositionEnd);
  host.addEventListener('focusin',scheduleViewport);
  host.addEventListener('focusout',scheduleViewport);
  window.addEventListener('resize',scheduleViewport);
  window.visualViewport?.addEventListener('resize',scheduleViewport);
  window.visualViewport?.addEventListener('scroll',scheduleViewport);
  const unsubscribe = runtime.subscribe(render); render();
  return () => {
    clearTimeout(autoTimer); unsubscribe(); runtime.destroy();
    host.removeEventListener('click',click); host.removeEventListener('submit',submit); host.removeEventListener('input',input);
    host.removeEventListener('change',change); host.removeEventListener('keydown',keydown); window.removeEventListener('pagehide',pagehide);
    host.removeEventListener('compositionstart',compositionStart);
    host.removeEventListener('compositionend',compositionEnd);
    host.removeEventListener('focusin',scheduleViewport);
    host.removeEventListener('focusout',scheduleViewport);
    window.removeEventListener('resize',scheduleViewport);
    window.visualViewport?.removeEventListener('resize',scheduleViewport);
    window.visualViewport?.removeEventListener('scroll',scheduleViewport);
    if (viewportFrame !== null) cancelAnimationFrame(viewportFrame);
    delete host.dataset.coachViewport;
    delete host.dataset.compactViewport;
    host.style.removeProperty('--app-height');
    host.style.removeProperty('--app-offset-top');
  };
}
