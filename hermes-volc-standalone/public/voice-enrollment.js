// Browser-only recorder; no sample is stored in localStorage.
/** @param {Float32Array} samples @param {number} sampleRate */
export function encodeWav(samples, sampleRate) {
  const rate = 16000;
  const count = Math.floor(samples.length * rate / sampleRate);
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  write(0, "RIFF"); view.setUint32(4, 36 + count * 2, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * sampleRate / rate), end = Math.max(start + 1, Math.floor((i + 1) * sampleRate / rate));
    let value = 0; for (let j = start; j < end && j < samples.length; j++) value += samples[j];
    value = Math.max(-1, Math.min(1, value / (end - start)));
    view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true);
  }
  return new Uint8Array(buffer);
}

/** @param {{deviceId?:string,track?:MediaStreamTrack,onProgress:(seconds:number)=>void,signal:AbortSignal}} options */
export async function recordVoiceSample({ deviceId, track, onProgress, signal }) {
  if (!globalThis.isSecureContext || !navigator.mediaDevices) throw new Error("Recording requires HTTPS or localhost.");
  const context = new AudioContext();
  let stream, processor, source, timer;
  const checkAbort = () => { if (signal.aborted) throw new DOMException("Recording cancelled", "AbortError"); };
  try {
    checkAbort();
    await context.resume();
    // Solo registration records the same microphone track that supplies the ASR.
    // Clone it so stopping the recorder cannot end the RTC track.
    stream = track ? new MediaStream([track.clone()]) : await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
    checkAbort();
    const actualDeviceId = stream.getAudioTracks()[0].getSettings().deviceId;
    if (!actualDeviceId) throw new Error("Could not identify the microphone. Select the device again.");
    const chunks = [];
    let count = 0;
    // A short registration recording only; no continuous audio processing on this node.
    processor = context.createScriptProcessor(4096, 1, 1);
    source = context.createMediaStreamSource(stream);
    source.connect(processor); processor.connect(context.destination);
    await new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("Recording cancelled", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(new Error("Recording did not finish. Keep this page open and try again.")), 30000);
      processor.onaudioprocess = event => {
        const chunk = event.inputBuffer.getChannelData(0).slice();
        chunks.push(chunk); count += chunk.length;
        onProgress(Math.min(20, Math.floor(count / context.sampleRate)));
        if (count >= context.sampleRate * 20) {
          signal.removeEventListener("abort", abort);
          resolve(undefined);
        }
      };
    });
    const samples = new Float32Array(Math.floor(context.sampleRate * 20));
    let p = 0;
    for (const chunk of chunks) { const part = chunk.subarray(0, samples.length - p); samples.set(part, p); p += part.length; }
    const bytes = encodeWav(samples, context.sampleRate);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { audio: btoa(binary), deviceId: actualDeviceId };
  } finally {
    clearTimeout(timer);
    if (processor) { processor.onaudioprocess = null; processor.disconnect(); }
    source?.disconnect(); stream?.getTracks().forEach(t => t.stop());
    await context.close();
  }
}
