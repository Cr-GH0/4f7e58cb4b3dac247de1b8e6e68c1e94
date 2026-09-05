import { validateSettings } from './model-settings.js';
import { PROMPT_EXAMPLES } from './prompt-examples.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 11 7-11 7Z"/></svg>';
const chevron = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
const ASR = [{ id: 'volc.seedasr.sauc.duration', name: 'Doubao Speech Recognition 2.0' }, { id: 'volc.bigasr.sauc.duration', name: 'Doubao Speech Recognition 1.0' }];
const TTS = [{ id: 'seed-tts-2.0', name: 'Doubao Speech Synthesis 2.0' }, { id: 'seed-tts-1.0', name: 'Doubao Speech Synthesis 1.0' }];
const resource = id => id === 'volc.service_type.10029' ? 'seed-tts-1.0' : id;
export const ADMIN_MARKUP = '<main class="admin-page"><header class="admin-header"><a href="/">← Back to Mimi</a><h1>Admin settings</h1></header><p role="status">Loading settings…</p></main>';

export function mountAdmin(host) {
  let saved = null, edit = null, tab = 'models', prompt = 'conversation', reauthenticate = false;
  let busy = false, error = '', message = '', disposed = false, catalog = null, catalogLoading = false, catalogError = '';
  let picker = '', query = '', voiceFilter = 'english', example = false, player = null, playing = '';
  const dirty = () => saved && JSON.stringify(edit) !== JSON.stringify(saved.settings);
  const model = () => catalog?.llm.items.find(x => x.id === edit.llm.model && x.target === edit.llm.target);
  const voice = () => catalog?.voices.items.find(x => x.id === edit.tts.speaker && x.resourceId === resource(edit.tts.resourceId));
  const speechName = (list, id) => list.find(x => x.id === resource(id))?.name || 'Custom model';
  async function api(path, method = 'GET', body) {
    const response = await fetch(`/api/admin/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) { const e = new Error(result.error || 'Could not complete the action. Try again.'); e.status = response.status; throw e; }
    return result;
  }
  const field = (path, label, attrs = '', hint = '', type = 'number', prefix = '') => {
    const [section, key] = path.split('.'), id = prefix + path;
    return `<div class="admin-field"><label for="${id}">${label}</label><input id="${id}" data-setting="${path}" type="${type}" value="${esc(edit[section][key])}" ${attrs} ${hint ? `aria-describedby="${id}-hint"` : ''}>${hint ? `<p class="admin-help" id="${id}-hint">${hint}</p>` : ''}</div>`;
  };
  const select = (path, label, choices) => {
    const [s, k] = path.split('.'), current = edit[s][k];
    return `<div class="admin-field"><label for="${path}">${label}</label><select id="${path}" data-setting="${path}">${!choices.some(x => x.id === resource(current)) ? `<option value="${esc(current)}">Current custom model</option>` : ''}${choices.map(x => `<option value="${esc(x.id)}" ${x.id === resource(current) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>`;
  };
  function stopAudio() { if (player) { player.pause(); player.onended = null; player.onerror = null; player = null; } playing = ''; }
  function rateLabel() { return edit.tts.speechRate === 0 ? 'Normal speed' : edit.tts.speechRate < 0 ? `${-edit.tts.speechRate}% slower` : `${edit.tts.speechRate}% faster`; }
  function modelsPanel() {
    const selected = model(), selectedVoice = voice();
    return `<div class="admin-panel-heading"><div><h2>Models & voice</h2><p>Choose how Mimi listens, responds, and speaks.</p></div><button type="button" data-admin="refresh" class="admin-text-button" ${catalogLoading ? 'disabled' : ''}>${catalogLoading ? 'Loading…' : 'Refresh list'}</button></div>
      <p class="admin-catalog-status" role="status">${esc(catalogError || (catalogLoading ? 'Loading models and voices from Volcengine…' : catalog ? `${catalog.llm.items.length} model versions and ${catalog.voices.items.length} voices available` : 'The list has not loaded yet'))}</p>
      <section class="admin-setting-row"><div><h3>Conversation model</h3><p>Understands contributions, replies to questions, and creates outlines.</p></div><div class="admin-control"><button type="button" class="admin-choice" id="choose-model" data-admin="picker" data-kind="model"><span><strong>${esc(selected?.name || 'Current model')}</strong><small>${esc(selected?.version ? `Version ${selected.version}` : edit.llm.model)}</small></span>${chevron}</button>${catalog?.llm.warnings.length ? `<p class="admin-help admin-warning">${esc(catalog.llm.warnings[0])}</p>` : ''}</div></section>
      <section class="admin-setting-row"><div><h3>Listening</h3><p>Turns speech from the microphone into a written transcript.</p></div><div class="admin-control">${select('asr.resourceId', 'Speech recognition model', catalog?.asr || ASR)}</div></section>
      <section class="admin-setting-row"><div><h3>Mimi’s voice</h3><p>Choose a speech model and preview its voices.</p></div><div class="admin-control">${select('tts.resourceId', 'Speech synthesis model', catalog?.tts || TTS)}<label for="choose-voice">Voice</label><div class="admin-voice-control"><button type="button" class="admin-choice" id="choose-voice" data-admin="picker" data-kind="voice"><span><strong>${esc(selectedVoice?.name || (edit.tts.speaker ? 'Current voice' : 'Choose a voice'))}</strong><small>${esc(selectedVoice ? [selectedVoice.gender && selectedVoice.gender, selectedVoice.languages.join(', ')].filter(Boolean).join(' · ') : edit.tts.speaker || 'Choose a voice supported by this model')}</small></span>${chevron}</button><button type="button" class="admin-preview" data-admin="play" data-voice="${esc(edit.tts.speaker)}" ${selectedVoice?.sample ? '' : 'disabled'} aria-label="${playing && playing === edit.tts.speaker ? 'Stop preview' : 'Preview current voice'}">${playIcon}<span>${playing && playing === edit.tts.speaker ? 'Stop' : 'Preview'}</span></button></div>${catalog?.voices.error ? `<p class="admin-help admin-warning">${esc(catalog.voices.error)}</p>` : ''}
      <div class="admin-rate"><label for="tts.speechRate">Speaking speed <output id="rate-value">${rateLabel()}</output></label><input id="tts.speechRate" data-setting="tts.speechRate" type="range" min="-50" max="100" step="1" value="${edit.tts.speechRate}" aria-valuetext="${rateLabel()}"><div class="admin-range-labels"><span>Slower</span><button type="button" data-admin="normal-rate">Reset speed</button><span>Faster</span></div></div></div></section>
      <details class="admin-advanced" data-detail="advanced"><summary>Advanced settings<span>Response tuning, speaker recognition, and custom IDs</span></summary><div class="admin-advanced-content"><h3>Response tuning</h3><p class="admin-help">Tune variation and output limits. To request shorter or longer replies, describe your preference in Coach instructions.</p><div class="admin-grid three-fields">${field('llm.temperature', 'Variation (Temperature)', 'min="0" max="1" step="0.01"', 'Lower values give more consistent wording. Higher values add variety.')}${field('llm.topP', 'Word choice (Top P)', 'min="0.01" max="1" step="0.01"', 'Lower values favor more likely word choices.')}${field('llm.maxTokens', 'Maximum output tokens', 'min="1" max="32768" step="1"', 'Caps reply length in model tokens, which differ from words.')}</div>
      <h3>Speaker recognition</h3><p class="admin-help">Volcengine provides voice matching without a choice of models. Adjust how confident a match must be before assigning a speaker.</p>${field('voiceprint.score', 'Speaker matching threshold', 'min="0" max="100" step="1"', 'Higher values leave more speech unassigned and reduce false matches. Lower values match more speech but may assign the wrong person. Range: 0–100. Default: 50.')}
      <details data-detail="manual"><summary>Enter model IDs manually</summary><p class="admin-help">Use a model not yet in the list or a custom endpoint.</p><div class="admin-grid"><div class="admin-field"><label for="llm.target">Connection type</label><select id="llm.target" data-setting="llm.target"><option value="model" ${edit.llm.target === 'model' ? 'selected' : ''}>Model</option><option value="endpoint" ${edit.llm.target === 'endpoint' ? 'selected' : ''}>Custom endpoint</option></select></div>${field('llm.model', 'Model or endpoint ID', 'maxlength="256" spellcheck="false"', '', 'text')}${field('asr.resourceId', 'Speech recognition resource ID', 'maxlength="256" spellcheck="false"', '', 'text', 'manual-')}${field('tts.resourceId', 'Speech synthesis resource ID', 'maxlength="256" spellcheck="false"', '', 'text', 'manual-')}${field('tts.speaker', 'Voice ID', 'maxlength="256" spellcheck="false"', '', 'text')}</div></details></div></details>`;
  }
  function promptsPanel() {
    const conversation = prompt === 'conversation';
    return `<div class="admin-panel-heading"><div><h2>Coach instructions</h2><p>Tell Mimi how to respond. Write instructions in the language you prefer.</p></div></div>
      <div class="admin-prompt-tabs" role="group" aria-label="Instruction purpose"><button type="button" data-admin="prompt-tab" data-prompt="conversation" aria-pressed="${conversation}">Conversation</button><button type="button" data-admin="prompt-tab" data-prompt="outline" aria-pressed="${!conversation}">Outlines</button></div>
      <div class="admin-prompt-layout"><div class="admin-editor"><div class="admin-editor-heading"><label for="prompts.${prompt}">${conversation ? 'Conversation instructions' : 'Outline instructions'}</label><button type="button" class="admin-text-button" data-admin="example">View example</button></div><textarea id="prompts.${prompt}" data-setting="prompts.${prompt}" rows="18" maxlength="${conversation ? 12000 : 6000}" aria-describedby="prompt-purpose" spellcheck="false">${esc(edit.prompts[prompt])}</textarea><p class="admin-help">These are the complete instructions. Edit them, then select Save changes.</p></div>
      <aside class="admin-guidance"><h3>When this is used</h3><p id="prompt-purpose">${conversation ? 'Mimi follows these instructions whenever it responds, in both solo practice and group discussion.' : 'Used when someone requests a Personal outline. Conversation instructions still apply; add the outline structure and length here.'}</p><h3>What you can change</h3><p>${conversation ? 'The topic, English level, reply length, and approach to questions and corrections.' : 'The outline structure, language, length, and how to mark missing content.'}</p><h3>Example</h3><blockquote>${conversation ? '“Respond to the idea first. Then mention one language issue that affects understanding, without correcting every sentence.”' : '“Organize the outline into a claim, reasons, and an example. Use only this student’s ideas. Mark missing examples as Not yet discussed.”'}</blockquote><p class="admin-help">${conversation ? 'Update the learning task when the class topic changes.' : 'Changes apply to new outlines. Existing outlines stay as they are.'}</p></aside></div>`;
  }
  function choiceList() {
    const needle = query.trim().toLocaleLowerCase().replace(/豆包/g, 'doubao');
    let choices = picker === 'model' ? catalog?.llm.items || [] : (catalog?.voices.items || []).filter(x => x.resourceId === resource(edit.tts.resourceId));
    const currentId = picker === 'model' ? edit.llm.model : edit.tts.speaker, current = picker === 'model' ? model() : voice();
    if (picker === 'voice' && voiceFilter === 'english') choices = choices.filter(x => x.languages.some(l => /English|英语/.test(l)) || x.id === currentId);
    choices = [...choices].sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId));
    if (needle) choices = choices.filter(x => [x.name, x.version, x.description, x.gender, x.languages?.join(' '), x.id].join(' ').toLocaleLowerCase().includes(needle));
    const fallback = !current && currentId && !needle ? `<p class="admin-help">Current ${picker === 'model' ? 'model' : 'voice'}: ${esc(currentId)}。${catalogLoading ? 'Looking up its name…' : 'Not in the current list. Your saved selection is kept.'}</p>` : '';
    return `${fallback}${choices.length ? choices.map(x => {
      const selected = x.id === currentId && (picker !== 'model' || x.target === edit.llm.target);
      const meta = picker === 'model' ? [x.version && `Version ${x.version}`, x.enabled ? 'Enabled on this account' : 'Provider catalog'].filter(Boolean).join(' · ') : [x.gender && x.gender, x.languages.join(', ')].filter(Boolean).join(' · ');
      return `<div class="admin-option ${selected ? 'is-selected' : ''}"><button type="button" data-admin="choose" data-id="${esc(x.id)}" data-target="${esc(x.target || '')}" aria-pressed="${selected}"><span class="admin-option-check" aria-hidden="true">${selected ? '✓' : ''}</span><span><strong>${esc(x.name)}</strong><small>${esc(meta)}</small>${x.description ? `<span class="admin-option-description">${esc(x.description)}</span>` : ''}</span></button>${picker === 'voice' ? `<button type="button" class="admin-preview" data-admin="play" data-voice="${esc(x.id)}" aria-label="${playing === x.id ? 'Stop preview' : `Preview ${esc(x.name)}`}" ${x.sample ? '' : 'disabled'}>${playIcon}<span>${playing === x.id ? 'Stop' : 'Preview'}</span></button>` : ''}</div>`;
    }).join('') : `<div class="admin-empty">${catalogLoading ? 'Loading the list…' : needle ? 'No matches. Try a shorter search or clear it.' : picker === 'voice' && voiceFilter === 'english' ? 'No voices are tagged English for this model. Try All languages.' : 'The list is unavailable. Select Retry.'}</div>`}`;
  }
  function dialogMarkup() {
    if (example) return `<dialog class="admin-dialog admin-example" aria-labelledby="dialog-title"><div class="admin-dialog-header"><h2 id="dialog-title">${prompt === 'conversation' ? 'Conversation' : 'Outlines'} · Example</h2><button type="button" data-admin="close" aria-label="Close example">×</button></div><p class="admin-help">Use this example as a starting point and adapt it to your class. It takes effect after saving.</p><pre>${esc(PROMPT_EXAMPLES[prompt])}</pre><div class="admin-dialog-footer"><button type="button" data-admin="close">Keep current instructions</button><button type="button" class="primary" data-admin="use-example">Use this example</button></div></dialog>`;
    if (!picker) return '';
    return `<dialog class="admin-dialog" aria-labelledby="dialog-title"><div class="admin-dialog-header"><div><h2 id="dialog-title">${picker === 'model' ? 'Choose a conversation model' : 'Choose a voice'}</h2><p>${picker === 'model' ? 'Select a model name to use that version.' : `${esc(speechName(TTS, edit.tts.resourceId))} · Preview a voice, then select its name`}</p></div><button type="button" data-admin="close" aria-label="Close selection">×</button></div><label class="sr-only" for="catalog-search">${picker === 'model' ? 'Search models' : 'Search voices'}</label><input type="search" id="catalog-search" placeholder="${picker === 'model' ? 'Search a name or version, e.g. Doubao or DeepSeek' : 'Search a name or voice ID'}" value="${esc(query)}" autocomplete="off">${picker === 'voice' ? `<div class="admin-filter" role="group" aria-label="Voice language"><button type="button" data-admin="voice-filter" data-filter="english" aria-pressed="${voiceFilter === 'english'}">English</button><button type="button" data-admin="voice-filter" data-filter="all" aria-pressed="${voiceFilter === 'all'}">All languages</button></div>` : ''}<div class="admin-options" id="catalog-options">${choiceList()}</div><p class="admin-error" role="alert" ${error || catalogError ? '' : 'hidden'}>${esc(error || catalogError)}</p><div class="admin-dialog-footer"><p>${esc(picker === 'model' ? (catalog?.llm.warnings[0] || 'Provider catalog models may need to be enabled on your account.') : catalog?.voices.error || 'Previews play the provider’s sample recordings.')}</p><button type="button" data-admin="refresh" ${catalogLoading ? 'disabled' : ''}>${catalogLoading ? 'Loading…' : 'Retry'}</button></div></dialog>`;
  }
  function render() {
    if (disposed) return;
    const focus = document.activeElement, focusedId = host.contains(focus) ? focus.id : '';
    const position = focusedId && (/^(text|search)$/.test(focus.type) || focus.tagName === 'TEXTAREA') ? [focus.selectionStart, focus.selectionEnd] : null;
    const openDetails = [...host.querySelectorAll('details[open][data-detail]')].map(x => x.dataset.detail);
    const scroll = host.querySelector('.admin-options')?.scrollTop || 0;
    host.innerHTML = `<main class="admin-page"><header class="admin-header"><a href="/">← Back to Mimi</a><h1>Admin settings</h1>${saved && !reauthenticate ? `<button type="button" class="admin-text-button" data-admin="logout" ${busy ? 'disabled' : ''}>Sign out</button>` : ''}</header>
      ${!saved || reauthenticate ? `<form class="admin-login" data-admin-form="login"><h2>Sign in</h2><p>Manage Mimi’s models, voice, and coaching instructions.</p><label for="admin-password">Admin password</label><input id="admin-password" name="password" type="password" autocomplete="current-password" required>${error ? `<p class="error-notice" role="alert">${esc(error)}</p>` : ''}<button class="primary" ${busy ? 'disabled' : ''}>${busy ? 'Signing in…' : 'Sign in'}</button></form>` : `
      <form class="admin-form" data-admin-form="settings" novalidate><div class="admin-layout"><nav class="admin-nav" aria-label="Admin settings"><button type="button" data-admin="tab" data-tab="models" aria-current="${tab === 'models' ? 'page' : 'false'}">Models & voice</button><button type="button" data-admin="tab" data-tab="prompts" aria-current="${tab === 'prompts' ? 'page' : 'false'}">Coach instructions</button><p>For solo practice<br>and group discussion</p></nav><fieldset class="admin-panel" ${busy ? 'disabled' : ''}>${tab === 'models' ? modelsPanel() : promptsPanel()}</fieldset></div>
      <footer class="admin-save"><div><p class="admin-status" role="status">${esc(message || (dirty() ? 'Unsaved changes' : 'All changes saved'))}</p><p class="admin-help">${dirty() ? 'Saved changes apply to the next call.' : saved.savedAt ? `Last saved ${new Date(saved.savedAt).toLocaleString('en-US')}` : 'Using default settings'}</p><p class="admin-error" role="alert" ${error ? '' : 'hidden'}>${esc(error)}</p></div><div class="admin-actions"><button type="button" data-admin="undo" ${busy || !dirty() ? 'disabled' : ''}>Discard changes</button><button type="submit" class="primary" id="save-settings" ${busy || !dirty() ? 'disabled' : ''}>${busy ? 'Saving…' : 'Save changes'}</button></div></footer></form>${dialogMarkup()}`}</main>`;
    for (const key of openDetails) { const details = host.querySelector(`[data-detail="${key}"]`); if (details) details.open = true; }
    const dialog = host.querySelector('dialog'); if (dialog) { dialog.showModal(); dialog.addEventListener('cancel', closeDialog); }
    const restored = focusedId && document.getElementById(focusedId);
    if (restored && host.contains(restored) && (!dialog || dialog.contains(restored))) { restored.focus({ preventScroll: true }); if (position && restored.setSelectionRange) restored.setSelectionRange(...position); }
    else if (picker) host.querySelector('#catalog-search')?.focus({ preventScroll: true });
    if (host.querySelector('.admin-options')) host.querySelector('.admin-options').scrollTop = scroll;
  }
  async function loadCatalog(refresh = false) {
    if (catalogLoading) return;
    catalogLoading = true; catalogError = ''; render();
    try { catalog = await api(`catalog${refresh ? '?refresh=1' : ''}`); }
    catch (e) { catalogError = e.message; }
    finally { catalogLoading = false; render(); }
  }
  async function load() { saved = await api('settings'); edit = structuredClone(saved.settings); error = ''; message = ''; void loadCatalog(); }
  function updateStatus() {
    const status = host.querySelector('.admin-status'); if (status) status.textContent = dirty() ? 'Unsaved changes' : 'All changes saved';
    const help = host.querySelector('.admin-save .admin-help'); if (help) help.textContent = 'Saved changes apply to the next call.';
    for (const button of host.querySelectorAll('#save-settings, [data-admin="undo"]')) button.disabled = busy || !dirty();
    for (const alert of host.querySelectorAll('.admin-error')) alert.hidden = true;
  }
  function onInput(event) {
    if (event.target.id === 'catalog-search') { query = event.target.value; host.querySelector('#catalog-options').innerHTML = choiceList(); return; }
    const path = event.target.dataset.setting; if (!path || !edit) return;
    const [section, key] = path.split('.'), old = edit[section][key];
    edit[section][key] = ['number', 'range'].includes(event.target.type) ? event.target.value === '' ? null : Number(event.target.value) : event.target.value;
    for (const sibling of host.querySelectorAll(`[data-setting="${path}"]`)) if (sibling !== event.target) sibling.value = event.target.value;
    message = ''; error = ''; updateStatus();
    if (path === 'tts.resourceId' && old !== edit.tts.resourceId && event.target.tagName === 'SELECT') { if (!voice()) edit.tts.speaker = ''; stopAudio(); render(); }
    if (path === 'tts.speechRate') { const output = host.querySelector('#rate-value'); if (output) output.textContent = rateLabel(); event.target.setAttribute('aria-valuetext', rateLabel()); }
    if (event.type === 'change' && event.target.id.startsWith('manual-')) render();
  }
  function closeDialog(event) {
    event?.preventDefault(); const target = picker === 'model' ? '#choose-model' : picker === 'voice' ? '#choose-voice' : '[data-admin="example"]';
    picker = ''; example = false; query = ''; stopAudio(); render(); host.querySelector(target)?.focus({ preventScroll: true });
  }
  const beforeUnload = event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } };
  async function submit(event) {
    const form = event.target.closest('[data-admin-form]'); if (!form) return;
    event.preventDefault(); if (busy) return;
    const isLogin = form.dataset.adminForm === 'login', password = isLogin ? new FormData(form).get('password') : null;
    try {
      if (!isLogin) {
        if (!edit.tts.speaker) { tab = 'models'; throw new Error('Choose a voice for Mimi before saving.'); }
        validateSettings(edit);
        if (catalog?.voices.items.some(v => v.id === edit.tts.speaker) && !voice()) { tab = 'models'; throw new Error('This voice is not supported by the selected speech model. Choose another voice.'); }
      }
      busy = true; error = ''; render();
      if (isLogin) {
        await api('login', 'POST', { password });
        if (reauthenticate) { reauthenticate = false; message = 'Signed in again. Your unsaved changes are still here.'; void loadCatalog(); } else await load();
      } else { saved = await api('settings', 'PUT', { revision: saved.revision, settings: edit }); edit = structuredClone(saved.settings); message = 'Saved. These settings will apply to the next call.'; }
    } catch (e) { error = e.message; if (!isLogin && e.status === 401) { reauthenticate = true; error = 'Your session expired. Sign in again to save. Your changes are still here.'; } }
    finally { busy = false; render(); if (isLogin && (!saved || reauthenticate)) host.querySelector('#admin-password')?.focus(); }
  }
  async function playVoice(id) {
    const sample = catalog?.voices.items.find(v => v.id === id)?.sample; if (!sample) return;
    const active = playing === id; stopAudio(); error = '';
    if (!active) {
      playing = id; player = new Audio(sample);
      player.onended = () => { stopAudio(); render(); };
      player.onerror = () => { stopAudio(); error = 'This sample could not play. Try another voice or try again later.'; render(); };
      try { await player.play(); } catch { stopAudio(); error = 'Could not play the sample. Try again.'; }
    }
    render();
  }
  async function click(event) {
    const button = event.target.closest('[data-admin]'); if (!button || busy) return;
    const action = button.dataset.admin;
    if (action === 'tab') { stopAudio(); tab = button.dataset.tab; error = ''; render(); return; }
    if (action === 'prompt-tab') { prompt = button.dataset.prompt; render(); return; }
    if (action === 'picker') { picker = button.dataset.kind; query = ''; error = ''; render(); return; }
    if (action === 'close') { closeDialog(); return; }
    if (action === 'voice-filter') { voiceFilter = button.dataset.filter; render(); return; }
    if (action === 'play') { await playVoice(button.dataset.voice); return; }
    if (action === 'normal-rate') { edit.tts.speechRate = 0; message = ''; render(); return; }
    if (action === 'example') { example = true; render(); return; }
    if (action === 'use-example') { edit.prompts[prompt] = PROMPT_EXAMPLES[prompt]; message = 'Example added. Edit it as needed, then save to apply.'; closeDialog(); return; }
    if (action === 'choose') {
      if (picker === 'model') { edit.llm.model = button.dataset.id; edit.llm.target = button.dataset.target; } else edit.tts.speaker = button.dataset.id;
      message = ''; closeDialog(); return;
    }
    if (action === 'undo') { edit = structuredClone(saved.settings); error = ''; message = 'Changes discarded.'; stopAudio(); render(); return; }
    if (action === 'refresh') { await loadCatalog(true); return; }
    if (action === 'logout' && dirty()) { error = 'You have unsaved changes. Save or discard them before signing out.'; render(); return; }
    if (action === 'logout') {
      try { busy = true; render(); await api('logout', 'POST', {}); stopAudio(); saved = null; edit = null; catalog = null; message = ''; }
      catch (e) { error = e.message; } finally { busy = false; render(); }
    }
  }
  host.addEventListener('input', onInput); host.addEventListener('change', onInput); host.addEventListener('submit', submit); host.addEventListener('click', click); window.addEventListener('beforeunload', beforeUnload);
  void load().catch(e => { if (e.status !== 401) error = e.message; }).finally(render);
  return () => { disposed = true; stopAudio(); host.removeEventListener('input', onInput); host.removeEventListener('change', onInput); host.removeEventListener('submit', submit); host.removeEventListener('click', click); window.removeEventListener('beforeunload', beforeUnload); };
}
