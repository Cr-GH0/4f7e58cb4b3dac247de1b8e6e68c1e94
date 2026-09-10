// Waveform-similarity overlap-add changes speech duration without shifting its
// pitch. All channels share alignment, and both ends of the utterance are kept.
export function fitSpeech(context, input, seconds) {
  const rate = input.sampleRate;
  const length = Math.round(seconds * rate);
  const output = context.createBuffer(input.numberOfChannels, length, rate);
  const source = Array.from({ length: input.numberOfChannels }, (_, i) => input.getChannelData(i));
  const target = Array.from({ length: input.numberOfChannels }, (_, i) => output.getChannelData(i));
  if (length === input.length) {
    source.forEach((channel, i) => target[i].set(channel));
    return output;
  }
  const window = Math.min(Math.round(rate * 0.04), input.length, length);
  const hop = Math.max(1, Math.floor(window / 2));
  const search = Math.round(rate * 0.012);
  const sourceEnd = input.length - window, targetEnd = length - window;
  source.forEach((channel, i) => target[i].set(channel.subarray(0, window)));
  let previous = 0, covered = window;
  for (let at = Math.min(hop, targetEnd); at > 0; at = Math.min(at + hop, targetEnd)) {
    const overlap = covered - at;
    const predicted = Math.round(at * sourceEnd / targetEnd);
    let selected = predicted;
    if (at !== targetEnd && overlap > 0) {
      // Search near the required pace for the closest waveform continuation.
      const low = Math.max(previous, predicted - search), high = Math.min(sourceEnd, predicted + search);
      let best = -Infinity;
      const score = candidate => {
        let dot = 0, a = 0, b = 0;
        for (let j = 0; j < overlap; j += 8) {
          const x = target[0][at + j], y = source[0][candidate + j];
          dot += x * y; a += x * x; b += y * y;
        }
        return dot / Math.sqrt(a * b + 1e-16);
      };
      for (let candidate = low; candidate <= high; candidate += 8) {
        const value = score(candidate);
        if (value > best) { best = value; selected = candidate; }
      }
      const coarse = selected;
      for (let candidate = Math.max(low, coarse - 7); candidate <= Math.min(high, coarse + 7); candidate++) {
        const value = score(candidate);
        if (value > best) { best = value; selected = candidate; }
      }
    }
    source.forEach((channel, i) => {
      for (let j = 0; j < window; j++) {
        const blend = j < overlap ? (1 - Math.cos(Math.PI * j / overlap)) / 2 : 1;
        target[i][at + j] = target[i][at + j] * (1 - blend) + channel[selected + j] * blend;
      }
    });
    previous = selected; covered = at + window;
    if (at === targetEnd) break;
  }
  return output;
}
