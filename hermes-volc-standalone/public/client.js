import { STUDENT_INITIAL_MARKUP, mountStudentEntry } from './student-entry.js';
import { createTalkClient } from './talk-client.js';
const host = document.querySelector('#app');
host.innerHTML = STUDENT_INITIAL_MARKUP;
mountStudentEntry(host, { loadRtc: async () => {
  const rtc = await import('/sdk/rtc.esm.min.js');
  return { default: rtc.default, RoomProfileType: rtc.RoomProfileType ?? rtc.default.RoomProfileType, MediaType: rtc.MediaType ?? rtc.default.MediaType };
}, talk: createTalkClient() });
