// Decode the complete set before advertising readiness. Playback never advances
// on an error; the caller retains the checkpoint until a real ended event.
export class ShowAudio {
  constructor({ contextFactory = () => new (window.AudioContext ?? window.webkitAudioContext)(), fetcher = (...args) => globalThis.fetch(...args) } = {}) {
    this.contextFactory = contextFactory;
    this.fetcher = fetcher;
    this.buffers = new Map();
    this.context = null;
    this.active = null;
  }
  get armed() { return this.context?.state === 'running'; }
  async arm() {
    this.context ??= this.contextFactory();
    await this.context.resume();
    if (!this.armed) throw new Error('Audio playback is unavailable.');
  }
  async prepare(content) {
    this.context ??= this.contextFactory();
    const entries = await Promise.all(['ack', ...content.narration.map(s => s.id)].map(async id => {
      const response = await this.fetcher(`/api/show/audio/${id}${content.version ? '?version=' + content.version : ''}`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('Audio is unavailable.');
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
      if (!(buffer.duration > 0)) throw new Error('The audio could not be decoded.');
      return [id, buffer];
    }));
    this.buffers = new Map(entries);
  }
  stop() {
    this.active?.cancel();
  }
  play(id, offset = 0, onProgress = () => {}, { onStart = () => {}, onLevel = () => {}, onEnd = () => {} } = {}) {
    this.stop();
    return new Promise((resolve, reject) => {
      const buffer = this.buffers.get(id);
      if (!this.armed || !buffer) return reject(new Error('Audio playback is unavailable.'));
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      const analyser = this.context.createAnalyser?.();
      if (analyser) {
        analyser.fftSize = 256;
        source.connect(analyser);
        analyser.connect(this.context.destination);
      } else source.connect(this.context.destination);
      const from = Math.max(0, Math.min(offset, Math.max(0, buffer.duration - 0.05)));
      const started = this.context.currentTime;
      let timer, meter, settled = false;
      const position = () => Math.min(buffer.duration, from + this.context.currentTime - started);
      const finish = error => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        clearInterval(meter);
        this.context.removeEventListener('statechange', checkState);
        source.onended = null;
        source.disconnect();
        analyser?.disconnect();
        onLevel(0); onEnd();
        if (this.active?.source === source) this.active = null;
        if (error) { try { source.stop(); } catch {} reject(error); }
        else resolve();
      };
      const checkState = () => {
        if (!this.armed) { onProgress(position()); finish(new Error('Audio playback was interrupted.')); }
      };
      this.active = { source, cancel: () => finish(new Error('Playback cancelled.')) };
      source.onended = () => { onProgress(buffer.duration); finish(); };
      this.context.addEventListener('statechange', checkState);
      try {
        source.start(0, from);
        onStart();
        if (analyser) {
          const samples = new Uint8Array(analyser.fftSize);
          meter = setInterval(() => {
            analyser.getByteTimeDomainData(samples);
            let energy = 0;
            for (const sample of samples) energy += ((sample - 128) / 128) ** 2;
            onLevel(Math.min(1, Math.sqrt(energy / samples.length) * 4));
          }, 50);
        }
        timer = setInterval(() => onProgress(position()), 1000);
      } catch (error) { finish(error); }
    });
  }
  dispose() { this.stop(); void this.context?.close(); this.buffers.clear(); }
}
