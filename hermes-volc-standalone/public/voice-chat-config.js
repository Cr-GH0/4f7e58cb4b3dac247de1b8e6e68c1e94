import { DEFAULT_SETTINGS } from './model-settings.js';

export const HERMES_SYSTEM_PROMPT = DEFAULT_SETTINGS.prompts.conversation;

/** @param {any} input */
export function parseVoiceOptions(input) {
  return { context: parseContext(input?.context) };
}

export function parseContext(value) {
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
  const { context } = parseVoiceOptions(input);
  return {
    AppId: input.appId, RoomId: input.roomId, TaskId: input.taskId,
    Config: {
      ASRConfig: {
        Provider: 'volcano', TurnDetectionMode: 0,
        // The student publishes no audio: input arrives as text through updates.
        // ASR stays configured because the room pipeline requires it, and the
        // streaming-only pass keeps any stray room audio from blocking turns.
        ProviderParams: { Mode: 'bigmodel', Credential: { ApiResourceId: settings.asr.resourceId }, StreamMode: 2, VolcanoASRParameters: JSON.stringify({request:{enable_nonstream:false}}) },
        VADConfig: { SilenceTime: 1000 },
        InterruptConfig: { InterruptKeywords: [], InterruptSpeechDuration: 0 },
      },
      // The agent keeps its own live history; the SystemMessages snapshot
      // covers reconnection and is refreshed on corrections.
      LLMConfig: { AutoActive: true, Mode: 'ArkV3', ...(settings.llm.target === 'endpoint' ? {EndPointId:settings.llm.model} : {ModelName:settings.llm.model}), SystemMessages: systemMessages(context, settings), HistoryLength: 12, ThinkingType: 'disabled', Temperature: settings.llm.temperature, TopP: settings.llm.topP, MaxTokens: settings.llm.maxTokens },
      TTSConfig: { Provider: 'volcano_bidirection', ProviderParams: { Credential: { ResourceId: settings.tts.resourceId }, VolcanoTTSParameters: JSON.stringify({req_params:{speaker:settings.tts.speaker,audio_params:{speech_rate:settings.tts.speechRate,loudness_rate:0},additions:{post_process:{pitch:0}}}}) } },
      InterruptMode: 0,
      SubtitleConfig: { DisableRTSSubtitle: false, SubtitleMode: 1 },
    },
    AgentConfig: { TargetUserId: [input.studentUserId], UserId: input.agentUserId, WelcomeMessage: '', EnableConversationStateCallback: true },
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
    // One round trip to keep replies under three seconds: stop the automatic
    // native reply, refresh the corrected context, then trigger the new round.
    // Ordering is guaranteed by the server executing these commands in sequence.
    updates.unshift({...base, Command:'interrupt'});
    // Never trigger a reply unless updating the corrected context succeeded.
    updates.push({...base, Command:'ExternalTextToLLM', Message:input.text.trim() + '\n.', InterruptMode:1});
  }
  return updates;
}
