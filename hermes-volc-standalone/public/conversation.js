import { GROUP_STORAGE_KEY, reduceSubtitle, correctSpeaker } from './group-session.js';

export const WORKSPACE_KEY = 'hermes.conversations.v2';
const id = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 28)}`;
export const newPerson = () => ({ memberId: id('p'), name: '', voiceprintId: '', deviceId: '' });

export function newConversation(mode = 'solo') {
  const people = Array.from({ length: mode === 'group' ? 3 : 1 }, newPerson);
  return { id: id('c'), mode, people, participantIds: people.map(p => p.memberId), lines: [], drafts: {}, revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

export function newWorkspace() {
  const conversation = newConversation();
  return { version: 2, currentId: conversation.id, conversations: [conversation] };
}

export const participants = conversation => conversation.participantIds.map(id => conversation.people.find(p => p.memberId === id)).filter(Boolean);
export const personName = (conversation, personId) => {
  const person = conversation.people.find(p => p.memberId === personId);
  if (!person) return 'Unassigned';
  if (person.name) return person.name;
  return conversation.mode === 'solo' ? 'You' : `Member ${conversation.people.indexOf(person) + 1}`;
};

export function readWorkspace(storage) {
  const raw = storage.getItem(WORKSPACE_KEY);
  if (raw) {
    const value = JSON.parse(raw);
    if (value.version !== 2 || !Array.isArray(value.conversations) || !value.conversations.length || !value.conversations.some(c => c.id === value.currentId)) throw new Error('Saved conversations could not be read. Export your data before continuing.');
    for (const c of value.conversations) {
      if (!['solo', 'group'].includes(c.mode) || !Array.isArray(c.people) || !Array.isArray(c.participantIds) || !Array.isArray(c.lines) || !c.drafts || c.participantIds.length !== (c.mode === 'solo' ? 1 : 3) || c.participantIds.some(id => !c.people.some(p => p.memberId === id))) throw new Error('Saved conversation data is incomplete. Export your data before continuing.');
    }
    return value;
  }
  const legacy = storage.getItem(GROUP_STORAGE_KEY);
  if (!legacy) return newWorkspace();
  const old = JSON.parse(legacy);
  if (old.version !== 1 || !Array.isArray(old.members) || old.members.length !== 3 || !Array.isArray(old.lines)) throw new Error('Older conversations could not be read. Export your data before continuing.');
  const conversation = newConversation('group');
  const mapping = new Map(old.members.map((p, i) => [p.memberId, conversation.people[i].memberId]));
  conversation.people = old.members.map((p, i) => ({ ...p, memberId: conversation.people[i].memberId }));
  conversation.lines = old.lines.map(line => ({ ...line, speakerId: mapping.get(line.speakerId) ?? null, seenSpeakers: (line.seenSpeakers ?? []).map(id => mapping.get(id)).filter(Boolean) }));
  return { version: 2, currentId: conversation.id, conversations: [conversation] };
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

export function receiveSubtitle(conversation, data, session, options = {}) {
  const context = { ...session, members: participants(conversation), solo: conversation.mode === 'solo', enrollmentPersonId: options.enrollmentPersonId };
  const lines = reduceSubtitle(conversation.lines, data, context);
  return { ...conversation, lines, revision: conversation.revision + 1, updatedAt: new Date().toISOString() };
}

export function addText(conversation, text, personId) {
  return { ...conversation, lines: [...conversation.lines, { key: id('text'), role: 'student', text: text.trim(), speakerId: personId, paragraph: true, corrected: true, source: 'text', timestamp: new Date().toISOString() }], revision: conversation.revision + 1, updatedAt: new Date().toISOString() };
}

export function saveDraft(conversation, personId, text, status = 'draft') {
  return { ...conversation, drafts: { ...conversation.drafts, [personId]: { text, status, sourceRevision: conversation.revision } }, revision: conversation.revision + 1, updatedAt: new Date().toISOString() };
}

export function extractIntroducedName(text) {
  const chinese = text.match(/(?:我叫|我的名字(?:叫|是))\s*([\p{Script=Han}·]{2,8})(?=[，。！、\s]|$)/u);
  if (chinese) return chinese[1];
  const english = text.match(/(?:[Mm]y name is|[Yy]ou can call me|I'm|I am)\s+([A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?)(?=[,.!，。\s]|$)/u);
  if (english && !/^(a|an|going|interested|happy|here|from|talking|thinking|not|ready|sorry|sure|glad|fine)$/i.test(english[1])) return english[1];
  return '';
}

const addressed = /^(?:(?:hey|hi|hello|okay|ok)[,，\s]+)?(?:mimi\b|米米|咪咪)[,，:：\s]*/i;
const waitIntent = /^(?:please\s+)?(?:just listen\b|wait(?: a (?:moment|minute))?\b|let(?:'s| us) discuss\b|we(?:'ll| will) discuss\b|我们先讨论|先听我们说|先听我说|先别回答|先不要回答|等一下|暂停回答)/i;

export function responseDecision(mode, text, speakerId, engagement) {
  const callsCoach = addressed.test(text.trim());
  const content = text.trim().replace(addressed, '');
  if (waitIntent.test(content) && (mode === 'solo' || callsCoach || engagement === speakerId || engagement === 'next')) return { action: 'listen', engagement: null, text: content };
  if (callsCoach || engagement === 'next') return { action: 'respond', engagement: mode === 'group' ? null : speakerId ?? null, text: content || 'The student called you. Ask briefly what they would like help with.' };
  if (mode === 'solo' && engagement !== null) return { action: 'respond', engagement, text: content };
  return { action: 'record', engagement: mode === 'group' ? null : engagement, text: content };
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
  return `Mimi · ${conversation.mode === 'solo' ? 'Solo' : 'Group of 3'} transcript\n${conversation.createdAt}\n\n${text}${drafts ? `\n\n${drafts}` : ''}`;
}
