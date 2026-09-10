// One audio clock owns the full classroom performance, including silent phases.
export const SHOW_TIMING = Object.freeze({
  opening: 5, work: 6, transition: 0.8, narration: Object.freeze([6, 14, 19, 10.2]), closing: 1, total: 62,
});
const parts = [
  { phase: 'ack', index: 0, audioId: 'ack', duration: 5 },
  ...[0, 1, 2, 3].map(index => ({ phase: 'trace', index, duration: 1.5 })),
  { phase: 'transition', index: 0, duration: 0.8 },
  ...['intro', 'case1', 'case2', 'method'].map((audioId, index) => ({ phase: 'narration', index, audioId, duration: SHOW_TIMING.narration[index] })),
  { phase: 'closing', index: 0, duration: 1 },
];
let cursor = 0;
export const SHOW_TIMELINE = Object.freeze(parts.map(part => {
  const entry = Object.freeze({ ...part, start: cursor, end: Math.round((cursor + part.duration) * 1000) / 1000 });
  cursor = entry.end;
  return entry;
}));
export function showPosition(seconds) {
  const part = SHOW_TIMELINE.find(item => seconds < item.end);
  return part ? { ...part, offset: Math.max(0, seconds - part.start) } : { phase: 'done', index: 0, offset: 0 };
}
export function showOffset(point) {
  if (point.phase === 'done') return SHOW_TIMING.total;
  const part = SHOW_TIMELINE.find(item => item.phase === point.phase && item.index === point.index);
  return part ? part.start + Math.min(part.duration, Math.max(0, point.offset)) : 0;
}
