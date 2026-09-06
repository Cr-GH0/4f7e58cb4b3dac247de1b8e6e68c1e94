// A confirmed sample belongs to one person and one microphone. Group identities
// are deliberately separate: Mode 2 labels speakers but does not reject them.
export function hasConfirmedVoice(person, deviceId) {
  return Boolean(person?.voiceConfirmed === true && person.voiceprintVersion === 2 && person.voiceprintId && person.deviceId === deviceId);
}

/** Mode 1 does not attach Mode 2's voiceprintId/score to subtitles. It separates
 * the enrolled voice, then EnableSV rejects non-matches with VoiceReject before
 * LLM entry. Require BOTH a final ASR and the matching native thinking event.
 * The runtime authenticates the bot/task/user before calling approveSoloRound.
 * Raw subtitles cannot grant themselves approval; partials stay in memory.
 */
export function acceptSoloSubtitle(pending, data, owner, threshold) {
  if (!Number.isInteger(data.roundId) || !Number.isInteger(data.sequence)) return null;
  const key = data.roundId;
  const old = pending.get(key);
  if (old?.done || (old && data.sequence < old.sequence)) return null;
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  const previous = old ?? {sequence:-1,text:'',approved:false,contested:false};
  const identity = typeof data.voiceprintId === 'string' ? data.voiceprintId : '';
  const score = Number.isFinite(data.voiceprintScore) ? data.voiceprintScore : null;
  const next = {
    ...previous, sequence:data.sequence,
    ...(text ? {text} : {}), data:{...data},
    // Defensively reject an explicit contradictory verdict if a future service
    // version adds identity fields. Missing fields are normal for Mode 1.
    contested:previous.contested || Boolean(identity && identity !== owner.voiceprintId) || (score !== null && score < threshold),
    final:data.paragraph === true,
  };
  pending.set(key,next);
  if (pending.size > 64) pending.delete(pending.keys().next().value);
  return release(next,owner);
}

export function approveSoloRound(pending, roundId, owner) {
  if (!Number.isInteger(roundId)) return null;
  const next=pending.get(roundId) ?? {sequence:-1,text:'',contested:false};
  next.approved=true; pending.set(roundId,next);
  if (pending.size > 64) pending.delete(pending.keys().next().value);
  return release(next,owner);
}

function release(next,owner) {
  if (next.done || !next.approved || !next.final || !next.text || next.contested) return null;
  next.done=true;
  return {...next.data,text:next.text,paragraph:true,voiceVerified:true,verifiedVoiceprintId:owner.voiceprintId,voiceVerification:'volcengine-mode1'};
}
