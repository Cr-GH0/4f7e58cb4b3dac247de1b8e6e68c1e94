import { fitSpeech } from './fit-speech.js';
import { SHOW_TIMELINE, SHOW_TIMING, makeTimeline } from './show-timing.js';
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
  async prepareOpening() {
    if (this.buffers.has('ack')) return;
    if (this.openingJob) return this.openingJob;
    this.openingJob = (async () => {
      this.context ??= this.contextFactory();
      const response = await this.fetcher('/api/show/opening', { cache: 'no-store', signal: AbortSignal.timeout(40000) });
      if (!response.ok) throw new Error('Mimi’s voice is not ready yet.');
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
      if (!(buffer.duration > 0)) throw new Error('Mimi’s voice could not be loaded.');
      this.buffers.set('ack', buffer);
    })().finally(() => { this.openingJob = null; });
    return this.openingJob;
  }
  async prepare(content, { opening = true } = {}) {
    this.context ??= this.contextFactory();
    const entries = await Promise.all([...(opening ? ['ack'] : []), ...content.narration.map(s => s.id)].map(async id => {
      const response = await this.fetcher(`/api/show/audio/${id}${content.version ? '?version=' + content.version : ''}`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('Audio is unavailable.');
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
      if (!(buffer.duration > 0)) throw new Error('The audio could not be decoded.');
      return [id, buffer];
    }));
    this.buffers = new Map([...(this.buffers.has('ack') ? [['ack', this.buffers.get('ack')]] : []), ...entries]);
  }
  async prepareShow(content) {
    await Promise.all([this.prepareOpening(), this.prepare(content, { opening: false })]);
    const durations = content.narration.map(part => this.buffers.get(part.id).duration);
    const natural = durations.reduce((sum, duration) => sum + duration, 0);
    const pace = natural / 49.2;
    if (pace < 0.8 || pace > 1.35) throw new Error('讲解长度不适合自然语速，请重新准备。');
    // Allocate the report slots by natural speech length. Every section uses
    // one pace; the opening, six-second work and total duration stay fixed.
    const slots = durations.map(duration => Math.round(duration / natural * 49200) / 1000);
    slots[3] = Math.round((49.2 - slots.slice(0, 3).reduce((sum, duration) => sum + duration, 0)) * 1000) / 1000;
    this.timeline = makeTimeline(slots);
    const spoken = this.timeline.filter(part => part.audioId);
    const rate = this.buffers.get('ack').sampleRate;
    const channels = Math.max(...spoken.map(part => this.buffers.get(part.audioId).numberOfChannels));
    const combined = this.context.createBuffer(channels, Math.round(SHOW_TIMING.total * rate), rate);
    for (const part of spoken) {
      const fitted = fitSpeech(this.context, this.buffers.get(part.audioId), part.duration);
      for (let channel = 0; channel < channels; channel++) {
        combined.getChannelData(channel).set(fitted.getChannelData(Math.min(channel, fitted.numberOfChannels - 1)), Math.round(part.start * rate));
      }
    }
    this.buffers.set('show', combined);
  }
  stop() {
    this.active?.cancel();
  }
  play(id, offset = 0, onProgress = () => {}, { onStart = () => {}, onLevel = () => {}, onEnd = () => {}, onPosition = () => {} } = {}) {
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
      let timer, meter, clock, settled = false;
      const position = () => Math.min(buffer.duration, from + this.context.currentTime - started);
      const finish = error => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        clearInterval(meter);
        clearInterval(clock);
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
        onPosition(from);
        clock = setInterval(() => onPosition(position()), 16);
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
