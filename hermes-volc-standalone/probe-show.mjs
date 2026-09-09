// Read-only deployment check. Does not create users, start a show, or call models.
const base = new URL(process.argv[2] || 'http://localhost:' + (process.env.PORT || 3000));
const results = [];
async function check(label, path, inspect) {
  try {
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(12000), redirect: 'follow' });
    await inspect(response);
    results.push({ label, ok: true });
    console.log('PASS ' + label);
  } catch (error) {
    results.push({ label, ok: false });
    console.error('FAIL ' + label + ': ' + error.message);
  }
}
function need(condition, message) { if (!condition) throw new Error(message); }
for (const path of ['/', '/client.js', '/student-entry.js', '/teacher-console.js', '/classroom-display.js', '/show-audio.js', '/show.css', '/mimi.png']) {
  await check('GET ' + path, path, async r => {
    need(r.status === 200, 'HTTP ' + r.status);
    need((await r.arrayBuffer()).byteLength > 0, 'Empty resource');
  });
}
await check('Report content', '/practice-report.html', async r => {
  need(r.status === 200, 'HTTP ' + r.status);
  const html = await r.text();
  need(html.includes('id="case1"') && html.includes('id="case2"') && html.includes('id="method"'), 'Report sections are missing');
});
await check('Public configuration', '/api/config', async r => {
  need(r.status === 200, 'HTTP ' + r.status);
  const data = await r.json();
  need(Number.isInteger(data.autoSendPauseMs), 'Auto-send configuration missing');
});
await check('Anonymous account state', '/api/student/status', async r => {
  need(r.status === 200, 'HTTP ' + r.status);
  need((await r.json()).account === null, 'Unexpected anonymous account');
});
for (const path of ['/api/show/state', '/api/show/content']) {
  await check('Teacher-only ' + path, path, async r => need(r.status === 401, 'Expected HTTP 401, got ' + r.status));
}
const passed = results.filter(x => x.ok).length;
console.log(passed + '/' + results.length + ' checks passed.');
if (passed !== results.length) process.exitCode = 1;
