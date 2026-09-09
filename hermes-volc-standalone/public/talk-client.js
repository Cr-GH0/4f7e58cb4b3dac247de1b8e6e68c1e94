// Browser side of compatibility mode: unlock audio playback and play Mimi's
// synthesized reply without any RTC SDK. Phones that lack the SDK — QQ Browser,
// UC, built-in webviews — still talk through typed messages.
export function createTalkClient(scope = globalThis) {
  let warmContext = null, player = null, playing = null;
  // Phones gate audio playback behind a gesture: open the audio elements once
  // inside the tap that sends a message, then later async replies can play.
  async function unlock() {
    try {
      const Context = scope.AudioContext ?? scope.webkitAudioContext;
      warmContext ??= new Context();
      await warmContext.resume();
      if (!player) {
        const view = new DataView(new ArrayBuffer(44 + 800));
        for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) for (let i = 0; i < 4; i++) view.setUint8(offset + i, text.charCodeAt(i));
        view.setUint32(4, 836, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        view.setUint32(40, 800, true);
        player = new Audio(URL.createObjectURL(new Blob([view.buffer], { type: 'audio/wav' })));
        player.volume = 0;
        await player.play();
      }
      if ('speechSynthesis' in scope) {
        const warm = new (scope.SpeechSynthesisUtterance ?? class {})('');
        warm.volume = 0;
        scope.speechSynthesis.speak(warm);
      }
    } catch { /* Playback stays locked; the UI offers a play button. */ }
  }
  function speak(text) {
    if (!('speechSynthesis' in scope) || !text) return Promise.resolve();
    return new Promise(resolve => {
      const utterance = new scope.SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      const english = scope.speechSynthesis.getVoices().find(v => /^en(-|_)/i.test(v.lang));
      if (english) utterance.voice = english;
      utterance.onend = resolve; utterance.onerror = resolve;
      scope.speechSynthesis.speak(utterance);
    });
  }
  async function play(base64, mime = 'audio/mpeg') {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    // Reuse the element unlocked inside the first gesture; a fresh element may
    // be blocked by the same autoplay policy on iOS.
    const audio = player ?? new Audio();
    // An overlapping play replaces the source; settle the previous wait first
    // so its caller never hangs waiting for events that will not fire.
    playing?.();
    await new Promise((resolve, reject) => {
      playing = resolve;
      audio.onended = () => { playing = null; resolve(); };
      audio.onerror = () => { playing = null; reject(new Error('PlaybackFailed')); };
      audio.src = url;
      audio.volume = 1;
      audio.play().catch(error => { playing = null; reject(error); });
    }).finally(() => { URL.revokeObjectURL(url); });
  }
  return { unlock, play, speak };
}
