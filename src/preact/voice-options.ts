import { OPENAI_TTS_VOICES } from '../openai.js';
import type { ConsumerStatus } from '../client.js';
export type VoiceEngine = 'browser' | 'api' | 'network';
export function shouldShowTtsVoiceRow(hasTtsAdapter: boolean, engine: VoiceEngine): boolean {
  return hasTtsAdapter && engine !== "browser";
}

/**
 * Resolves the voice-name choices offered by the TTS picker for the current
 * engine (§2.4):
 *  - `network`: the room's advertised union (`consumerStatus.voices`, built
 *    by `unionVoices` in ../client.ts from every connected TTS provider's
 *    `provider_hello.voices`). Never falls back to `OPENAI_TTS_VOICES` — a
 *    name the room doesn't actually support would mislead the user into
 *    picking it.
 *  - `api`: a live `fetchVoices()` result if non-empty, else the
 *    app-supplied adapter list (`voice.tts.voiceOptions`), else
 *    `OPENAI_TTS_VOICES` as the final UI-only fallback.
 *  - `browser`: never rendered (see shouldShowTtsVoiceRow), so `[]`.
 */
export function resolveTtsVoiceOptions(params: {
  engine: VoiceEngine;
  consumerStatus?: ConsumerStatus;
  fetchedApiVoices: string[];
  adapterVoiceOptions?: string[];
}): string[] {
  if (params.engine === "network") {
    return params.consumerStatus?.phase === "connected" ? (params.consumerStatus.voices ?? []) : [];
  }
  if (params.engine === "api") {
    if (params.fetchedApiVoices.length > 0) return params.fetchedApiVoices;
    if (params.adapterVoiceOptions && params.adapterVoiceOptions.length > 0) return params.adapterVoiceOptions;
    return OPENAI_TTS_VOICES;
  }
  return [];
}

/**
 * The full ordered list of `<option>` values for the TTS voice `<select>`:
 * the "provider default" sentinel (`''`, §2.4 — voice omitted, provider
 * answers with its own configured voice) always first, then the currently
 * saved voice if `voiceOptions` doesn't already include it (so a value
 * written by another app/session, or one the current engine's catalog
 * doesn't happen to advertise, stays visible and selected instead of
 * silently reverting to the default), then the offered choices.
 */
export function buildTtsVoiceOptionValues(voiceOptions: string[], currentVoice: string): string[] {
  const extra = currentVoice && !voiceOptions.includes(currentVoice) ? [currentVoice] : [];
  return ["", ...extra, ...voiceOptions];
}

