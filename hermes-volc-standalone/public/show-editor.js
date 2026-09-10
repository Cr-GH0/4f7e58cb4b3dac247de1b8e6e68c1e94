const html = document.querySelector('#html'), prompt = document.querySelector('#prompt');
const save = document.querySelector('#save'), status = document.querySelector('#status');
const upload = document.querySelector('#import-html'), preview = document.querySelector('#preview');
let saved = null, saving = false, previewTimer;
const dirty = () => saved && (html.value !== saved.html || prompt.value !== saved.prompt);
function notice(text, error = false) { status.textContent = text; status.classList.toggle('is-error', error); }
function changed() {
  save.disabled = saving || !dirty();
  notice(dirty() ? '有未保存的修改。' : '内容已保存，从下一轮演示生效。');
}
async function api(body) {
  const response = await fetch('/api/show/editor', { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const data = await response.json();
  if (response.status === 401) throw new Error('请先用教师账号登录，再打开后台。');
  if (!response.ok) throw new Error(data.error ?? '暂时无法保存，请重试。');
  return data;
}
function updatePreview() { clearTimeout(previewTimer); preview.srcdoc = html.value; }
html.addEventListener('input', () => { changed(); clearTimeout(previewTimer); previewTimer = setTimeout(updatePreview, 350); });
prompt.addEventListener('input', changed);
upload.addEventListener('change', async () => {
  const file = upload.files?.[0]; if (!file) return;
  try { html.value = await file.text(); changed(); updatePreview(); }
  catch { notice('无法读取这个 HTML 文件，请重新选择。', true); }
  upload.value = '';
});
for (const name of ['html', 'prompt']) {
  document.querySelector('#tab-' + name).addEventListener('click', () => {
    for (const panel of ['html', 'prompt']) {
      document.querySelector('#tab-' + panel).setAttribute('aria-selected', String(panel === name));
      document.querySelector('#panel-' + panel).hidden = panel !== name;
    }
  });
}
save.addEventListener('click', async () => {
  if (saving || !saved) return;
  saving = true; save.disabled = true; notice('正在保存…');
  const submission = { html: html.value, prompt: prompt.value };
  try {
    saved = await api(submission);
    notice(dirty() ? '提交的内容已保存；编辑区还有新的修改。' : '已保存，从下一轮演示生效。');
  } catch (error) { notice(error.message, true); }
  finally { saving = false; save.disabled = !dirty(); }
});
window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
try {
  saved = await api(); html.value = saved.html; prompt.value = saved.prompt;
  html.disabled = prompt.disabled = upload.disabled = false; updatePreview();
  notice('修改 HTML 产物或 Hermes 提示词后，点击保存。');
} catch (error) { notice(error.message, true); }
