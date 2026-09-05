import { INITIAL_MARKUP, mountCoach } from './coach-view.js';
const host = document.querySelector('#app');
host.innerHTML = INITIAL_MARKUP;
mountCoach(host, { loadRtc: async () => {
  const rtc = await import('/sdk/rtc.esm.min.js');
  return { default: rtc.default, RoomProfileType: rtc.RoomProfileType ?? rtc.default.RoomProfileType, MediaType: rtc.MediaType ?? rtc.default.MediaType };
} });
