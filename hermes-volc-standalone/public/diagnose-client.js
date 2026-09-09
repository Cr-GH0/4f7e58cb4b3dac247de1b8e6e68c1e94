// Real-time voice diagnosis for phones where Mimi's live link fails.
// Runs the same steps as a real call (mic → SDK → room → publish) and
// renders one copyable report so failures can be reported verbatim.

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A short WAV with a non-empty (silent) data chunk. Chrome, Edge, Firefox and
// Safari all refuse decodeAudioData when the data chunk is empty, so the probe
// tone must contain real zero samples to test the decode path on every browser.
function silentWavBuffer() {
  const sampleRate = 8000, samples = 160, dataSize = samples * 2;
  const view = new DataView(new ArrayBuffer(44 + dataSize));
  const tag = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  tag(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, dataSize, true);
  return view.buffer;
}

export const DIAGNOSE_MARKUP = '<main class="diagnose"><h1>Mimi voice diagnosis</h1><p role="status">Press start, allow the microphone, and speak a few words when asked.</p><button class="primary" data-diagnose="run">Start diagnosis</button><ol class="diagnose-steps"></ol><textarea class="diagnose-report" rows="14" readonly hidden></textarea><button data-diagnose="copy" hidden>Copy report</button></main>';

const ms = since => `${Date.now() - since}ms`;
// One readable name per supported browser family for the report header.
const browserName = () => {
  const ua = navigator.userAgent;
  const pick = re => { const m = ua.match(re); return m ? ` ${m[1]}` : ''; };
  if (/EdgA?\//.test(ua)) return `Edge${pick(/EdgA?\/([\d.]+)/)}`;
  if (/Firefox\//.test(ua)) return `Firefox${pick(/Firefox\/([\d.]+)/)}`;
  if (/Chrome\//.test(ua)) return `Chrome${pick(/Chrome\/([\d.]+)/)}`;
  if (/Safari\//.test(ua)) return `Safari${pick(/Version\/([\d.]+)/)}`;
  return 'Unknown browser';
};

export function mountDiagnose(host, { loadSdk }) {
  let running = false, report = '';
  const steps = [];
  function render() {
    host.innerHTML = DIAGNOSE_MARKUP;
    const list = host.querySelector('.diagnose-steps');
    for (const step of steps) {
      const item = document.createElement('li');
      item.textContent = step.ok === true ? `✓ ${step.name} (${step.ms})` : step.ok === false ? `✗ ${step.name}: ${step.detail}` : `· ${step.name}`;
      if (step.ok === false) item.setAttribute('data-failed', 'true');
      list.appendChild(item);
    }
    const box = host.querySelector('.diagnose-report');
    if (report) { box.hidden = false; box.value = report; }
    const copy = host.querySelector('[data-diagnose="copy"]');
    if (report) copy.hidden = false;
  }
  async function step(name, run) {
    const entry = { name, ok: null, detail: '', ms: '' };
    steps.push(entry); render();
    const started = Date.now();
    try {
      const detail = await run();
      entry.ok = true; entry.ms = ms(started); entry.detail = detail || '';
    } catch (error) {
      entry.ok = false; entry.detail = `${error?.name ?? 'Error'}: ${error?.message ?? error}`;
    }
    render();
    return entry;
  }
  function line(label, value) { return `${label}: ${value}`; }
  async function run() {
    if (running) return;
    running = true; steps.length = 0; report = '';
    let engine = null, VERTC = null, session = null, stream = null, context = null, analyzerTimer = null;
    const finish = () => {
      try { analyzerTimer && clearInterval(analyzerTimer); } catch { /* ignore */ }
      try { stream?.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
      try { context?.close(); } catch { /* ignore */ }
      try { engine?.leaveRoom?.(false); } catch { /* ignore */ }
      running = false; render();
    };
    try {
      const info = [];
      info.push(line('Browser', browserName()));
      info.push(line('URL', location.href));
      info.push(line('Secure (HTTPS)', window.isSecureContext));
      info.push(line('User agent', navigator.userAgent));
      await step('Browser environment', () => info.join(' | '));
      report = `Mimi voice diagnosis\n${info.join('\n')}\n`;

      let track = null;
      const mic = await step('Microphone permission + capture', async () => {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia API missing');
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        track = stream.getAudioTracks()[0];
        if (!track) throw new Error('no audio track returned');
        const settings = track.getSettings?.() ?? {};
        return `track ${track.readyState}, label "${track.label}", device ${settings.deviceId ?? 'unknown'}, ${JSON.stringify(settings.sampleRate ?? '')}`;
      });
      if (!mic.ok) return finish();

      const audio = await step('Audio decode (browser playback path)', async () => {
        const Context = window.AudioContext ?? window.webkitAudioContext;
        if (!Context) throw new Error('AudioContext missing');
        context = new Context();
        await context.resume();
        const decoded = await context.decodeAudioData(silentWavBuffer());
        return `sampleRate ${context.sampleRate}, decode ${decoded.duration}s ok`;
      });

      const offer = await step('WebRTC offer (browser real-time support)', async () => {
        const PC = window.RTCPeerConnection ?? window.webkitRTCPeerConnection;
        if (!PC) throw new Error('RTCPeerConnection missing');
        const pc = new PC();
        try {
          pc.addTransceiver('audio', { direction: 'sendonly' });
          const description = await pc.createOffer();
          await pc.setLocalDescription(description);
          const munged = description.sdp ?? '';
          const opus = /opus/i.test(munged);
          return `SDP ${munged.length} chars, Opus listed: ${opus}`;
        } finally { pc.close(); }
      });
      report += `\nMicrophone: ${mic.detail ?? ''}\nAudio decode: ${audio.detail ?? ''}\nWebRTC offer: ${offer.detail ?? ''}\n`;

      const sdk = await step('Volcengine RTC SDK load', async () => {
        VERTC = (await loadSdk()).default;
        const version = VERTC?.version?.() ?? VERTC?._version ?? 'unknown';
        return `loaded, version ${version}`;
      });
      report += `RTC SDK: ${sdk.ok ? sdk.detail : `FAILED ${sdk.detail}`}\n`;
      if (!sdk.ok) return finish();

      const sessionStep = await step('Session credentials (/api/session)', async () => {
        const response = await fetch('/api/session', { method: 'POST' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        session = await response.json();
        return `room ${session.roomId}, expires in ${Math.round((session.expiresAt * 1000 - Date.now()) / 60000)}min`;
      });
      report += `Session: ${sessionStep.ok ? sessionStep.detail : `FAILED ${sessionStep.detail}`}\n`;
      if (!sessionStep.ok) return finish();

      const created = await step('RTC engine create', async () => {
        engine = VERTC.createEngine(session.appId);
        if (!engine) throw new Error('createEngine returned nothing');
        return 'ok';
      });
      report += `Engine: ${created.ok ? created.detail : `FAILED ${created.detail}`}\n`;

      let joinEvents = [];
      const enabled = await step('Enable devices', async () => {
        const permission = await Promise.race([
          VERTC.enableDevices({ audio: true, video: false }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('enableDevices timeout 10s')), 10000)),
        ]);
        if (!permission?.audio) throw new Error(`audio not enabled ${JSON.stringify(permission ?? {})}`);
        return 'audio enabled';
      });
      report += `Enable devices: ${enabled.ok ? enabled.detail : `FAILED ${enabled.detail}`}\n`;

      const joined = await step('Join room (real-time handshake)', async () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('joinRoom timeout 12s — this is the handshake failure seen in class')), 12000);
        const onEvent = VERTC.events;
        engine.on?.(onEvent.onError, event => { joinEvents.push(`error ${event.errorCode}`); });
        engine.on?.(onEvent.onUserJoined, () => { joinEvents.push('bot joined'); });
        Promise.race([
          engine.joinRoom(session.rtcToken, session.roomId, { userId: session.userId, extraInfo: JSON.stringify({ call_scene: 'RTC-AIGC' }) }, { isAutoPublish: false, isAutoSubscribeAudio: true, roomProfileType: VERTC.RoomProfileType?.chat ?? 0 }),
          new Promise((_, reject2) => setTimeout(() => reject2(new Error('joinRoom promise timeout 12s')), 12000)),
        ]).then(result => {
          clearTimeout(timer);
          // Success criterion matches the live app: joinRoom resolved without
          // throwing. Resolved values differ per SDK version (numeric code,
          // {code}, or a {users,streams} room snapshot) and carry no failure
          // meaning, so report the shape instead of judging it.
          const shape = typeof result === 'number' ? `code ${result}` : result && typeof result === 'object' ? `resolved ${JSON.stringify(result).slice(0, 120)}` : `resolved ${String(result)}`;
          resolve(`${shape} ${joinEvents.join(', ') || '(no error events)'}`);
        }, error => { clearTimeout(timer); reject(error); });
      }));
      report += `Join room: ${joined.ok ? joined.detail : `FAILED ${joined.detail}`}\n`;

      const published = await step('Publish microphone stream', async () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('publishStream timeout 10s')), 10000);
        Promise.race([
          engine.publishStream(VERTC.MediaType?.AUDIO ?? 1),
          new Promise((_, reject2) => setTimeout(() => reject2(new Error('publishStream promise timeout 10s')), 10000)),
        ]).then(result => { clearTimeout(timer); const code = typeof result === 'number' ? result : result?.code ?? result; resolve(`code ${JSON.stringify(code)}`); }, error => { clearTimeout(timer); reject(error); });
      }));
      report += `Publish: ${published.ok ? published.detail : `FAILED ${published.detail}`}\n`;

      const level = await step('Live audio level (speak out loud now, 5 seconds)', async () => new Promise(resolve => {
        const Context = window.AudioContext ?? window.webkitAudioContext;
        const probe = new Context();
        probe.resume().then(() => {
          const source = probe.createMediaStreamSource(stream);
          const analyzer = probe.createAnalyser();
          analyzer.fftSize = 256;
          source.connect(analyzer);
          const buffer = new Uint8Array(analyzer.frequencyBinCount);
          let peak = 0;
          const timer = setInterval(() => {
            analyzer.getByteTimeDomainData(buffer);
            for (const value of buffer) peak = Math.max(peak, Math.abs(value - 128));
          }, 100);
          setTimeout(() => {
            clearInterval(timer);
            try { source.disconnect(); probe.close(); } catch { /* ignore */ }
            resolve(peak > 3 ? `peak ${peak} — microphone is sending audio` : `peak ${peak} — SILENT: nothing picked up during the 5s window (did you speak?)`);
          }, 5000);
        }, () => resolve('AudioContext resume refused'));
      }));
      report += `Audio level: ${level.detail ?? ''}\n`;

      report += `\nResult: ${joined.ok && published.ok && !/SILENT/.test(level.detail ?? '') ? 'Every step works — live voice should work here. Report this to the teacher anyway.' : 'FAILED steps above are the problem. Send this whole report to the teacher.'}`;
      finish();
    } catch (error) {
      report += `\nUnexpected error: ${error?.name ?? 'Error'}: ${error?.message ?? error}\n`;
      finish();
    }
  }
  host.addEventListener('click', event => {
    const button = event.target.closest('[data-diagnose]');
    if (!button || button.disabled) return;
    if (button.dataset.diagnose === 'run') { button.disabled = true; void run().finally(() => { button.disabled = false; }); }
    if (button.dataset.diagnose === 'copy') {
      const box = host.querySelector('.diagnose-report');
      box?.select();
      navigator.clipboard?.writeText(box?.value ?? '').catch(() => {});
    }
  });
  render();
}
