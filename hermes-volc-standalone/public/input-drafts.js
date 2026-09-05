const KEY = 'hermes.input-drafts.v1';

// Editing is separate from submitted speech. Keys include the conversation and
// person/utterance so switching a panel never gives another person this draft.
export function createInputDrafts(storage) {
  let values = {}, error = '', readable = true;
  try {
    const raw = storage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
      values = parsed;
    }
  } catch { readable = false; error = 'Could not read your unsent text.'; }
  const key = (conversationId, field, owner = '') => JSON.stringify([conversationId, field, owner]);
  function persist() {
    if (!readable) return;
    try { storage.setItem(KEY, JSON.stringify(values)); error = ''; }
    catch { error = 'Your unsent text has not been saved. Keep this page open.'; }
  }
  return {
    get(conversationId, field, owner = '', fallback = '') {
      const value = values[key(conversationId, field, owner)];
      return typeof value === 'string' ? value : fallback;
    },
    set(conversationId, field, owner, value) {
      values[key(conversationId, field, owner)] = value; persist();
    },
    clear(conversationId, field, owner = '') {
      delete values[key(conversationId, field, owner)]; persist();
    },
    has(conversationId) {
      const prefix = JSON.stringify([conversationId]).slice(0,-1) + ',';
      return Object.keys(values).some(k => k.startsWith(prefix) && values[k]);
    },
    get error() { return error; },
  };
}
