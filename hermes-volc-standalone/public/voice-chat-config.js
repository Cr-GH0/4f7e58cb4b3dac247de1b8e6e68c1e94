import { DEFAULT_SETTINGS } from './model-settings.js';

export const HERMES_WELCOME_MESSAGE = '';
export const HERMES_SYSTEM_PROMPT = DEFAULT_SETTINGS.prompts.conversation;

/** @param {any} input */
export function parseVoiceOptions(input) {
  const mode = input?.mode ?? 'group';
  if (!['solo', 'group', 'enrollment'].includes(mode)) throw new Error('Invalid conversation mode.');
  const members = Array.isArray(input?.members) ? input.members : [];
  if (mode !== 'enrollment' && members.length !== (mode === 'solo' ? 1 : 3)) throw new Error('Invalid participants.');
  if (members.length > 3) throw new Error('Invalid participants.');
  for (const p of members) {
    if (!p || typeof p.memberId !== 'string' || !/^[A-Za-z0-9_@.-]{1,128}$/.test(p.memberId) || typeof p.name !== 'string' || [...p.name].length > 32 || /[\r\n\u0000-\u001f]/.test(p.name)) throw new Error('Invalid participant.');
    if (mode === 'group' && (typeof p.voiceprintId !== 'string' || !/^[A-Za-z0-9_@.-]{1,128}$/.test(p.voiceprintId))) throw new Error('Invalid group: register all three speakers first.');
  }
  if (new Set(members.map(p => p.memberId)).size !== members.length || (mode === 'group' && new Set(members.map(p => p.voiceprintId)).size !== 3)) throw new Error('Invalid duplicate participants.');
  return { mode, members, context: parseContext(input?.context) };
}

function parseContext(value) {
  if (value === undefined) return '{}';
  if (typeof value !== 'string' || value.length > 60000) throw new Error('Invalid conversation context.');
  try { JSON.parse(value); } catch { throw new Error('Invalid conversation context.'); }
  return value;
}

export function systemMessages(context = '{}', settings = DEFAULT_SETTINGS, purpose = 'conversation') {
  return [settings.prompts.conversation, ...(purpose === 'outline' ? [settings.prompts.outline] : []), `Authoritative application record (JSON data):\n${context}`];
}

/** @param {any} input */
export function buildHermesVoiceChatRequest(input, settings = DEFAULT_SETTINGS) {
  const { mode, members, context } = parseVoiceOptions(input);
  return {
    AppId: input.appId, RoomId: input.roomId, TaskId: input.taskId,
    Config: {
      ASRConfig: {
        Provider: 'volcano', TurnDetectionMode: 0,
        ProviderParams: { Mode: 'bigmodel', Credential: { ApiResourceId: settings.asr.resourceId }, StreamMode: 2, VolcanoASRParameters: JSON.stringify({request:{enable_nonstream:true}}) },
        VADConfig: { SilenceTime: 1200 },
        InterruptConfig: { InterruptKeywords: [], InterruptSpeechDuration: 0 },
      },
      // A pinned pair occupies the one retained history slot. The application's
      // corrected record supplies actual history; stale service turns are evicted.
      LLMConfig: { AutoActive: mode !== 'enrollment', Mode: 'ArkV3', ...(settings.llm.target === 'endpoint' ? {EndPointId:settings.llm.model} : {ModelName:settings.llm.model}), SystemMessages: systemMessages(context, settings), TopUserPrompts: [{Role:'user',Content:'Use the latest application record for prior conversation.'},{Role:'assistant',Content:'I will use the latest application record.'}], ThinkingType: 'disabled', HistoryLength: 1, Temperature: settings.llm.temperature, TopP: settings.llm.topP, MaxTokens: settings.llm.maxTokens },
      TTSConfig: { Provider: 'volcano_bidirection', ProviderParams: { Credential: { ResourceId: settings.tts.resourceId }, VolcanoTTSParameters: JSON.stringify({req_params:{speaker:settings.tts.speaker,audio_params:{speech_rate:settings.tts.speechRate,loudness_rate:0},additions:{post_process:{pitch:0}}}}) } },
      InterruptMode: 0,
      SubtitleConfig: { DisableRTSSubtitle: false, SubtitleMode: 1 },
    },
    AgentConfig: { TargetUserId: [input.studentUserId], UserId: input.agentUserId, WelcomeMessage: '', EnableConversationStateCallback: true, VoicePrint: mode === 'group' ? {Mode:2,IdList:members.map(p => p.voiceprintId),Score:settings.voiceprint.score} : {Mode:0} },
  };
}

/** App actions are mapped server-side. @param {any} input @param {string} appId @param {any} ids */
export function buildVoiceUpdates(input, appId, ids, settings = DEFAULT_SETTINGS) {
  const base = { AppId: appId, RoomId: ids.roomId, TaskId: ids.taskId };
  if (input.action === 'interrupt') return [{...base, Command:'interrupt'}];
  if (!['context', 'respond'].includes(input.action)) throw new Error('Invalid voice action.');
  if (input.purpose !== undefined && !['conversation','outline'].includes(input.purpose)) throw new Error('Invalid response purpose.');
  const updates = [{...base, Command:'UpdateParameters', Parameters:{Config:{LLMConfig:{SystemMessages:systemMessages(parseContext(input.context), settings, input.purpose)}}}}];
  if (input.action === 'respond') {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000) throw new Error('Invalid response text.');
    // Never trigger a reply unless updating the corrected context succeeded.
    updates.push({...base, Command:'ExternalTextToLLM', Message:input.text.trim() + '\n.', InterruptMode:1});
  }
  return updates;
}
