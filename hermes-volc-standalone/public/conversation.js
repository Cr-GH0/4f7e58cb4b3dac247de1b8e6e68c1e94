// Subtitle reduction and speaker correction live here since the group era
// ended; they serve every conversation.

/** @param {any[]} lines @param {any} data @param {{taskId:string,botUserId:string}} context */
export function reduceSubtitle(lines, data, context) {
  if (!data || typeof data !== "object" || typeof data.userId !== "string") return lines;
  const role = data.userId === context.botUserId ? "hermes" : "student";
  const text = typeof data.text === "string" ? data.text.trim() : "";
  const round = Number.isInteger(data.roundId) ? data.roundId : null;
  const seq = Number.isInteger(data.sequence) ? data.sequence : null;
  const baseKey = `${context.taskId}:${data.userId}:${round ?? `unmatched_${lines.length}`}`;
  const candidates = lines.filter(l => l.key === baseKey || l.key.startsWith(baseKey + ':segment_'));
  const latest = candidates[candidates.length - 1];
  let key = latest?.key ?? baseKey;
  // A finalized utterance followed by a new interim one starts a new segment.
  if (role === 'student' && latest?.paragraph && data.paragraph !== true && text && seq !== null && seq > latest.sequence) key = `${baseKey}:segment_${seq}`;
  const index = lines.findIndex(l => l.key === key);
  const old = index >= 0 ? lines[index] : null;
  if (!text && !old) return lines;
  if (old && role === "student" && seq !== null && seq < old.sequence) return lines;
  if (old?.paragraph && role === "student" && data.paragraph !== true && text) return lines;
  // Room subtitles carry no speaker identity: typed input owns attribution,
  // and a manual correction keeps whatever speaker it assigned.
  const fragments = { ...(old?.fragments ?? {}) };
  if (role === "hermes" && text) fragments[seq ?? Object.keys(fragments).length] = text;
  const line = {
    ...old, key, taskId: context.taskId, role, userId: data.userId, roundId: round,
    sequence: seq === null ? (old?.sequence ?? -1) + 1 : Math.max(seq, old?.sequence ?? -1),
    text: old?.textCorrected ? old.text : role === "hermes" ? Object.keys(fragments).sort((a,b) => Number(a)-Number(b)).map(k => fragments[k]).join(" ") : text || old?.text || "",
    fragments, paragraph: data.paragraph === true || old?.paragraph === true,
    speakerId: old?.corrected ? old.speakerId : null,
    corrected: old?.corrected ?? false,
    timestamp: old?.timestamp ?? new Date().toISOString(),
  };
  const next = [...lines];
  if (index >= 0) next[index] = line; else next.push(line);
  return next;
}

/** @param {any[]} lines @param {string} key @param {string|null} speakerId */
export function correctSpeaker(lines, key, speakerId) {
  return lines.map(l => l.key === key && l.role === "student" ? { ...l, speakerId, corrected: true } : l);
}

export const WORKSPACE_KEY = 'hermes.conversations.v2';
const id = prefix => `${prefix}_${Array.from(crypto.getRandomValues(new Uint8Array(14)), b => b.toString(16).padStart(2, '0')).join('')}`;
export const newPerson = () => ({ memberId: id('p'), name: '' });

export function newConversation() {
  const person = newPerson();
  return { id: id('c'), people: [person], participantIds: [person.memberId], lines: [], drafts: {}, revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

export function newWorkspace() {
  const conversation = newConversation();
  return { version: 2, currentId: conversation.id, conversations: [conversation] };
}

export const participants = conversation => conversation.participantIds.map(id => conversation.people.find(p => p.memberId === id)).filter(Boolean);
export const personName = (conversation, personId) => {
  const person = conversation.people.find(p => p.memberId === personId);
  if (!person) return 'Unassigned';
  return person.name || 'You';
};

export function readWorkspace(storage) {
  const raw = storage.getItem(WORKSPACE_KEY);
  if (!raw) return newWorkspace();
  const value = JSON.parse(raw);
  if (value.version !== 2 || !Array.isArray(value.conversations) || !value.conversations.length || !value.conversations.some(c => c.id === value.currentId)) throw new Error('Saved conversations could not be read. Export your data before continuing.');
  for (const c of value.conversations) {
    if (!Array.isArray(c.people) || !Array.isArray(c.participantIds) || c.participantIds.length !== 1 || !Array.isArray(c.lines) || !c.drafts || c.participantIds.some(id => !c.people.some(p => p.memberId === id))) throw new Error('Saved conversation data is incomplete. Export your data before continuing.');
  }
  return value;
}

export function updatePerson(conversation, personId, changes) {
  // Display-name corrections do not change a person's identity or prior attribution.
  return { ...conversation, people: conversation.people.map(p => p.memberId === personId ? { ...p, ...changes, memberId: p.memberId } : p), revision: conversation.revision + 1, updatedAt: new Date().toISOString() };
}

export function replacePerson(conversation, personId) {
  if (!conversation.participantIds.includes(personId)) throw new Error('This person is not in the current conversation.');
  const person = newPerson();
  return { ...conversation, people: [...conversation.people, person], participantIds: conversation.participantIds.map(id => id === personId ? person.memberId : id), revision: conversation.revision + 1, updatedAt: new Date().toISOString() };
}

/** The signed-in account owns the single member of every conversation. */
export function attachAccount(conversation, account) {
  if (!account) return conversation;
  const previousId = conversation.participantIds[0], memberId = `student_${account.id}`;
  const owner = { memberId, name: account.name };
  return { ...conversation, participantIds: [memberId], people: [owner],
    lines: conversation.lines.map(line => ({ ...line, speakerId: line.speakerId === previousId ? memberId : line.speakerId, targetPersonId: line.targetPersonId === previousId ? memberId : line.targetPersonId })),
    drafts: Object.fromEntries(Object.entries(conversation.drafts).map(([key, value]) => [key === previousId ? memberId : key, value])),
  };
}

function invalidateDrafts(conversation, people) {
  return Object.fromEntries(Object.entries(conversation.drafts).map(([personId, draft]) => [personId, people.includes(personId) ? { ...draft, status: 'needs_review' } : draft]));
}

export function correctAttribution(conversation, key, personId) {
  if (personId !== null && !conversation.people.some(p => p.memberId === personId)) throw new Error('This person could not be found.');
  const line = conversation.lines.find(l => l.key === key && l.role === 'student');
  if (!line) return conversation;
  return { ...conversation, lines: correctSpeaker(conversation.lines, key, personId), drafts: invalidateDrafts(conversation, [line.speakerId, personId]), revision: conversation.revision + 1, updatedAt: new Date().toISOString() };
}

export function correctText(conversation, key, text) {
  const line = conversation.lines.find(l => l.key === key);
  if (!line || !text.trim()) return conversation;
  return { ...conversation, lines: conversation.lines.map(l => l.key === key ? { ...l, originalText: l.originalText ?? l.text, text: text.trim(), textCorrected: true } : l), drafts: invalidateDrafts(conversation, [line.speakerId]), revision: conversation.revision + 1, updatedAt: new Date().toISOString() };
}

export function receiveSubtitle(conversation, data, session) {
  const lines = reduceSubtitle(conversation.lines, data, session);
  return { ...conversation, lines, revision: conversation.revision + 1, updatedAt: new Date().toISOString() };
}

export function addText(conversation, text, personId) {
  return { ...conversation, lines: [...conversation.lines, { key: id('text'), role: 'student', text: text.trim(), speakerId: personId, paragraph: true, corrected: true, source: 'text', timestamp: new Date().toISOString() }], revision: conversation.revision + 1, updatedAt: new Date().toISOString() };
}

/** One compatibility-mode exchange: the recognized recording and Mimi's reply. */
export function addTalkExchange(conversation, personId, studentText, replyText) {
  const stamp = new Date().toISOString();
  const lines = [...conversation.lines];
  if (studentText?.trim()) lines.push({ key: id('talk'), role: 'student', text: studentText.trim(), speakerId: personId, paragraph: true, corrected: true, source: 'talk', timestamp: stamp });
  if (replyText?.trim()) lines.push({ key: id('talk'), role: 'hermes', text: replyText.trim(), speakerId: 'hermes', paragraph: true, source: 'talk', timestamp: stamp });
  return { ...conversation, lines, revision: conversation.revision + 1, updatedAt: stamp };
}

export function saveDraft(conversation, personId, text, status = 'draft') {
  return { ...conversation, drafts: { ...conversation.drafts, [personId]: { text, status, sourceRevision: conversation.revision } }, revision: conversation.revision + 1, updatedAt: new Date().toISOString() };
}

export function conversationContext(conversation) {
  const roster = conversation.people.map(p => ({ personId: p.memberId, name: personName(conversation, p.memberId), present: conversation.participantIds.includes(p.memberId) }));
  let remaining = 24000;
  const selected = [];
  for (const line of [...conversation.lines].reverse()) {
    if (!line.paragraph || !line.text.trim()) continue;
    const entry = { id: line.key, personId: line.role === 'student' ? line.speakerId : 'hermes', forPersonId: line.targetPersonId ?? null, text: line.text };
    const length = JSON.stringify(entry).length;
    if (length > remaining) break;
    selected.unshift(entry); remaining -= length;
  }
  const outlines = Object.fromEntries(Object.entries(conversation.drafts).filter(([id]) => conversation.participantIds.includes(id)).map(([id,d]) => [id,{...d,text:d.text.slice(0,6000)}]));
  return JSON.stringify({ revision: conversation.revision, people: roster, records: selected, olderRecordsOmitted: selected.length < conversation.lines.filter(l => l.paragraph && l.text.trim()).length, outlines });
}

export function exportConversation(conversation, personId = null) {
  const lines = conversation.lines.filter(l => personId === 'unknown' ? l.role === 'student' && !l.speakerId : !personId || l.speakerId === personId || l.targetPersonId === personId);
  const text = lines.map(l => `${l.role === 'hermes' ? 'Mimi' : personName(conversation, l.speakerId)}${l.paragraph ? '' : ' (incomplete)'}\n${l.text}`).join('\n\n');
  const drafts = Object.entries(conversation.drafts).filter(([id]) => !personId || id === personId).map(([id, d]) => `${personName(conversation, id)} · Outline${d.status === 'needs_review' ? ' (transcript changed; review needed)' : ''}\n${d.text}`).join('\n\n');
  return `Mimi · conversation transcript\n${conversation.createdAt}\n\n${text}${drafts ? `\n\n${drafts}` : ''}`;
}
