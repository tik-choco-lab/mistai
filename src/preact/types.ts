import type { LlmProviderV1, ModelRefV1, VoiceConfigV1 } from '../llm-config.js';
import type { RoomProvideV1 } from '../room-provider.js';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const reasoningEffortOptions: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const REASONING_EFFORT_OPTIONS: readonly ReasoningEffort[] = reasoningEffortOptions;
export type TaskModelV1 = { ref?: ModelRefV1; reasoningEffort: ReasoningEffort };
export type RoomProvide = RoomProvideV1;
export type LlmLocalSettings = { tasks: Record<string, TaskModelV1>; roomProvide: Record<string, RoomProvide>; recentModels: ModelRefV1[] };
export interface LlmSettingsLocalAdapter {
  get(): LlmLocalSettings;
  set(value: LlmLocalSettings): void;
  subscribe?(cb: () => void): () => void;
}
export interface LlmSettingsTask { id: string; label: string; tip?: string; reasoning?: boolean }
export interface LlmSettingsVoiceAdapter {
  tts?: { voiceOptions?: string[]; get?(): VoiceConfigV1 | undefined; set?(value: VoiceConfigV1): void };
  stt?: { get?(): VoiceConfigV1 | undefined; set?(value: VoiceConfigV1): void };
}
export interface LlmSettingsMicAdapter {
  deviceId: string; onChange(deviceId: string): void;
  devices?: { deviceId: string; label: string }[];
  labelsHidden?: boolean; onUnlockLabels?(): void | Promise<void>;
}
export type ProviderSettings = LlmLocalSettings & { providers: LlmProviderV1[]; defaultModel?: ModelRefV1 };
