import test from 'node:test';
import assert from 'node:assert/strict';
import { SHOW_TIMING, SHOW_TIMELINE, showPosition, showOffset } from './public/show-timing.js';
import { fitSpeech } from './public/fit-speech.js';
import { ShowAudio } from './public/show-audio.js';
const buffer = (channels, length, sampleRate) => {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: index => data[index] };
};
const context = { createBuffer: buffer };
test('every spoken and silent phase fills one continuous 62-second timeline', () => {
  assert.equal(SHOW_TIMELINE.at(-1).end, 62);
  assert.equal(SHOW_TIMELINE.filter(p => p.phase === 'trace').reduce((s, p) => s + p.duration, 0), 6);
  for (const [index, part] of SHOW_TIMELINE.entries()) {
    assert.equal(part.start, index ? SHOW_TIMELINE[index - 1].end : 0);
    assert.equal(showOffset(showPosition(part.start + part.duration / 2)), part.start + part.duration / 2);
  }
  assert.equal(showPosition(61.999).phase, 'closing');
  assert.equal(showPosition(62).phase, 'done');
});
test('speech fitting preserves pitch and the end of the utterance at different durations', () => {
  const rate = 16000, input = buffer(2, rate * 3, rate);
  for (let i = 0; i < input.length; i++) input.getChannelData(0)[i] = input.getChannelData(1)[i] = Math.sin(2 * Math.PI * 180 * i / rate) * 0.5;
  for (const seconds of [2.5, 3.6]) {
    const fitted = fitSpeech(context, input, seconds), samples = fitted.getChannelData(0);
    assert.equal(fitted.duration, seconds);
    assert.ok(samples.every(Number.isFinite));
    let crossings = 0;
    for (let i = rate / 2; i < samples.length - rate / 2; i++) if (samples[i - 1] <= 0 && samples[i] > 0) crossings++;
    assert.ok(Math.abs(crossings / (seconds - 1) - 180) < 2, 'pitch stays at 180 Hz');
    assert.deepEqual(samples.slice(-100), input.getChannelData(0).slice(-100), 'last speech samples are retained');
    assert.deepEqual(samples, fitted.getChannelData(1));
  }
});
test('one decoded performance includes exactly six silent work seconds and an uncut spoken ending', async () => {
  const audio = new ShowAudio(); audio.context = context;
  audio.prepareOpening = async () => {};
  audio.prepare = async () => {};
  for (const part of SHOW_TIMELINE.filter(p => p.audioId)) {
    const segment = buffer(1, Math.round(part.duration * 1000), 1000); segment.getChannelData(0).fill(0.2);
    audio.buffers.set(part.audioId, segment);
  }
  await audio.prepareShow({ narration: ['intro','case1','case2','method'].map(id => ({ id })) });
  const show = audio.buffers.get('show'), data = show.getChannelData(0);
  assert.equal(show.duration, SHOW_TIMING.total);
  assert.ok(data.slice(5000, 11800).every(x => x === 0));
  assert.ok(data.slice(60800, 61000).every(x => x > 0));
  assert.ok(data.slice(61000).every(x => x === 0));
});

test('narration parts share one pace and extreme speech lengths cannot advertise readiness', async () => {
  const audio = new ShowAudio(); audio.context = context;
  audio.prepareOpening = audio.prepare = async () => {};
  const narration = ['intro', 'case1', 'case2', 'method'].map(id => ({ id }));
  audio.buffers.set('ack', buffer(1, 5500, 1000));
  const durations = [7, 15, 24, 12];
  narration.forEach((part, index) => audio.buffers.set(part.id, buffer(1, durations[index] * 1000, 1000)));
  await audio.prepareShow({ narration });
  const parts = audio.timeline.filter(part => part.phase === 'narration');
  for (const [i, part] of parts.entries()) assert.ok(Math.abs(durations[i] / part.duration - 58 / 49.2) < 0.0002);
  assert.equal(audio.timeline.at(-1).end, 62);
  audio.buffers.set('case2', buffer(1, 90000, 1000));
  await assert.rejects(audio.prepareShow({ narration }), /自然语速/);
});
